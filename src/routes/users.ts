import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { getAchievementsForUser, pendingAchievements, markAchievementsSeen } from '../services/achievements.js';
import { getGiftsForUser, giftInfo } from '../services/gifts.js';
import { liveStateFrom, departsInSeconds } from '../services/live.js';
import { horizonFor } from '../services/horizon.js';
import { MIN_COUNTRIES_TO_RETURN, REASON_LABEL, ArchiveReason } from '../services/journey.js';
import { agradecer, fraseValida, recadosDe, marcarRecadosLidos, jaAgradecidos } from '../services/thanks.js';
import { webPushLigado } from '../services/notify.js';
import { config } from '../config/index.js';
import { codigoDeConvite, placarDeConvites } from '../services/indicacao.js';
import bcrypt from 'bcryptjs';
import { excluirConta } from '../services/exclusao.js';
import { idiomaSuportado, tr } from '../services/i18n.js';

let cacheTextos: { at: number; mapa: Record<string, string> } | null = null;

export async function userRoutes(app: FastifyInstance) {

  // ── DELETE /users/me ───────────────────────────────────────────────────────
  /**
   * A pessoa apaga a própria conta.
   *
   * Exige a SENHA, e não só o token. Token do Adrift não expira: um aparelho
   * esquecido aberto, ou um token copiado, poderia apagar a conta de alguém
   * sem que essa pessoa soubesse. A senha é a prova de que quem pede é quem é.
   *
   * O que a exclusão faz — e por que não é um DELETE — está em
   * services/exclusao.ts. Resumo: anonimiza, arquiva os barcos, e deixa nos
   * barcos as mensagens que estranhos já receberam, como o Termo promete.
   */
  app.delete<{ Body: { password?: string } }>(
    '/users/me',
    {
      schema: {
        body: { type: 'object', required: ['password'], properties: {
          password: { type: 'string', minLength: 1, maxLength: 200 },
        } },
      },
      // roda bcrypt: mesmo teto das outras rotas que rodam
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const { rows } = await pool.query(
        `SELECT password_hash, lang FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      if (!rows.length) return reply.code(404).send({ error: 'not_found' });

      const lang = idiomaSuportado(rows[0].lang);

      if (!rows[0].password_hash) {
        // Conta de Google não tem senha para conferir. Não dá para provar quem
        // é pelo caminho normal, então este pedido vai pelo e-mail — que é o
        // que o Termo já diz e o que permite conferir a identidade.
        return reply.code(400).send({
          error: 'sem_senha',
          message: tr(lang, 'Esta conta entra pelo Google. Para excluí-la, escreva para contact@adriftapp.fun a partir do e-mail da conta.'),
        });
      }

      const confere = await bcrypt.compare(req.body.password ?? '', rows[0].password_hash);
      if (!confere) {
        return reply.code(401).send({
          error: 'senha_incorreta',
          message: tr(lang, 'Senha incorreta.'),
        });
      }

      await excluirConta(userId);
      return reply.send({ status: 'ok' });
    },
  );

  // ── GET /users/me/convite ──────────────────────────────────────────────────
  /**
   * O link de convite da pessoa, mais o placar do que ele já rendeu.
   *
   * O código nasce aqui, na primeira vez que alguém pede — quem nunca convidar
   * ninguém não carrega um código à toa, e não foi preciso preencher a coluna
   * para quem já existia.
   */
  app.get('/users/me/convite', async (req, reply) => {
    const userId = (req as any).user?.id;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

    const code = await codigoDeConvite(userId);
    const base = process.env.APP_URL ?? 'https://adriftapp.fun';
    const placar = await placarDeConvites(userId);

    return reply.send({ code, link: `${base}/?convite=${code}`, ...placar });
  });
  // ── GET /users/me/achievements ─────────────────────────────────────────────
  app.get(
    '/users/me/achievements',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      const data = await getAchievementsForUser(userId);
      return reply.send(data);
    },
  );

  // ── GET /settings/text ─────────────────────────────────────────────────────
  // Os textos que o dono edita no painel e o app mostra. Só os de TEXTO: os
  // números são regra de funcionamento e não têm por que sair daqui.
  //
  // Cache curto no servidor porque toda abertura do Pier passa por aqui, e o
  // texto muda uma vez por mês, não uma vez por segundo.
  app.get('/settings/text', {}, async (_req, reply) => {
    const agora = Date.now();
    if (!cacheTextos || agora - cacheTextos.at > 60_000) {
      const { rows } = await pool.query(
        `SELECT key, value FROM system_settings WHERE kind = 'text'`,
      );
      const mapa: Record<string, string> = {};
      for (const r of rows) mapa[r.key] = r.value;
      cacheTextos = { at: agora, mapa };
    }
    return reply.send(cacheTextos.mapa);
  });

  // ── Conquistas pendentes de comemoração ────────────────────────────────────
  app.get('/users/me/achievements/pending', {}, async (req, reply) => {
    const userId = (req as any).user?.id;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const pend = await pendingAchievements(userId);
    return reply.send({
      pending: pend.map(a => ({
        id: a.id, title: a.title, description: a.description,
        tier: a.tier, icon: a.icon,
        gift: giftInfo(a.gift ?? null),
      })),
    });
  });

  app.post<{ Body: { ids: string[] } }>(
    '/users/me/achievements/ack',
    { schema: { body: { type: 'object', required: ['ids'], properties: {
      ids: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 40 },
    } } } },
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      await markAchievementsSeen(userId, req.body.ids);
      return reply.send({ ok: true });
    },
  );

  // ── Pausa de recebimento ───────────────────────────────────────────────────
  app.get('/users/me/pause', {}, async (req, reply) => {
    const userId = (req as any).user?.id;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const { rows } = await pool.query(`SELECT receiving_paused FROM users WHERE id = $1`, [userId]);
    return reply.send({ paused: rows[0]?.receiving_paused ?? false });
  });

  app.post<{ Body: { paused: boolean } }>(
    '/users/me/pause',
    { schema: { body: { type: 'object', required: ['paused'], properties: {
      paused: { type: 'boolean' },
    } } } },
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      await pool.query(`UPDATE users SET receiving_paused = $1 WHERE id = $2`, [req.body.paused, userId]);
      return reply.send({ paused: req.body.paused });
    },
  );

  // ── GET /users/me/gifts ────────────────────────────────────────────────────
  app.get(
    '/users/me/gifts',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      const data = await getGiftsForUser(userId);
      return reply.send(data);
    },
  );

  // ── GET /users/me/push-key ────────────────────────────────────────────────
  // A chave pública VAPID, que o navegador precisa para assinar. Vem do
  // servidor em vez de estar fixa no cliente para as duas nunca saírem de
  // sincronia: trocar a chave no Railway passa a valer sem republicar o site.
  // Devolve vazio quando o Web Push está desligado — e aí o cliente nem pede
  // permissão, em vez de pedir e não entregar nada.
  app.get('/users/me/push-key', async () => ({
    key: webPushLigado() ? config.push.vapidPublic : '',
  }));

  // ── POST /users/me/push-subscription ──────────────────────────────────────
  // Uma assinatura POR NAVEGADOR. A mesma pessoa tem a do trabalho, a de casa e
  // a do celular, e todas devem tocar: adivinhar em qual ela está foi o que fez
  // um barco se perder.
  app.post<{ Body: { endpoint: string; keys: { p256dh: string; auth: string } } }>(
    '/users/me/push-subscription',
    { schema: { body: { type: 'object', required: ['endpoint', 'keys'], properties: {
      endpoint: { type: 'string', minLength: 10, maxLength: 1000 },
      keys: { type: 'object', required: ['p256dh', 'auth'], properties: {
        p256dh: { type: 'string', maxLength: 200 },
        auth:   { type: 'string', maxLength: 100 },
      } },
    } } } },
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const { endpoint, keys } = req.body;
      // O mesmo endpoint pode trocar de dono: um computador compartilhado onde
      // alguém sai e outro entra. O ON CONFLICT reatribui em vez de recusar —
      // senão o segundo nunca receberia aviso nenhum.
      await pool.query(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (endpoint) DO UPDATE
           SET user_id = EXCLUDED.user_id,
               p256dh  = EXCLUDED.p256dh,
               auth    = EXCLUDED.auth`,
        [userId, endpoint, keys.p256dh, keys.auth,
         (req.headers['user-agent'] ?? '').slice(0, 300)],
      );
      return reply.send({ status: 'ok' });
    },
  );

  // ── DELETE /users/me/push-subscription ────────────────────────────────────
  app.delete<{ Body: { endpoint: string } }>(
    '/users/me/push-subscription',
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      await pool.query(
        `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
        [userId, (req.body as any)?.endpoint ?? ''],
      );
      return reply.send({ status: 'ok' });
    },
  );

  // ── POST /users/me/push-token ─────────────────────────────────────────────
  // O app registra aqui seu token do Expo Push (Android/iOS)
  app.post<{ Body: { token: string } }>(
    '/users/me/push-token',
    { schema: { body: { type: 'object', required: ['token'], properties: {
      token: { type: 'string', minLength: 10, maxLength: 200 },
    } } } },
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      await pool.query(
        `UPDATE users SET fcm_token = $1 WHERE id = $2`,
        [req.body.token, userId],
      );
      return reply.send({ status: 'ok' });
    },
  );

  // ── GET /users/me/boats ────────────────────────────────────────────────────
  app.get(
    '/users/me/boats',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const { rows } = await pool.query(
        `SELECT
           b.id,
           b.status,
           b.stage,
           b.unique_countries,
           b.created_at,
           b.last_hop_at,
           b.arrives_home_at,
           b.unique_countries >= ${MIN_COUNTRIES_TO_RETURN} AS can_return,
           LEFT(bm.content, 80) AS initial_message,
           (
             SELECT COUNT(DISTINCT user_id)
             FROM boat_country_interactions
             WHERE boat_id = b.id
           ) AS total_unique_interactions,
           (SELECT COUNT(*)::int FROM boat_messages WHERE boat_id = b.id) AS message_count,
           lq.is_bot,
           lq.typing_at,
           lq.responds_at
         FROM boats b
         JOIN boat_messages bm
           ON bm.boat_id = b.id
           AND bm.created_at = (
             SELECT MIN(created_at) FROM boat_messages WHERE boat_id = b.id
           )
         LEFT JOIN LATERAL (
           SELECT
             (u.oauth_provider = 'bot') AS is_bot,
             rq.typing_at,
             rq.arrives_at,
             -- prazo efetivo do bot: chegada + leitura (5..45min) OU pouco
             -- antes de a fila expirar — o que vier primeiro
             LEAST(
               rq.arrives_at + ((5 + ABS(HASHTEXT(rq.id::text)) % 41) || ' minutes')::interval,
               rq.expires_at - INTERVAL '2 minutes'
             ) AS responds_at
           FROM receiver_queue rq
           JOIN users u ON u.id = rq.user_id
           WHERE rq.boat_id = b.id AND rq.status = 'pending'
           ORDER BY rq.queued_at DESC
           LIMIT 1
         ) lq ON TRUE
         WHERE b.creator_user_id = $1
           AND b.status <> 'archived'   -- arquivados vivem no Museu do Porto
         ORDER BY b.created_at DESC`,
        [userId],
      );

      // Selos ao vivo da lista: estado + partida estimada (só bots têm hora).
      // Detalhes internos (is_bot, typing_at, responds_at) não saem da API.
      const boats = rows.map((r) => {
        // arrives_at PRECISA entrar aqui. Sem ele, liveStateFrom pula o teste
        // de "ainda em viagem" e nunca devolve 'sailing' para esta lista: um
        // barco no meio do oceano era anunciado como 'waiting', e — pior —
        // como 'typing' nos sete minutos antes da resposta marcada, ou seja,
        // "escrevendo agora" com o barco ainda a horas do porto. A tela de
        // detalhe acertava porque passa a linha inteira da fila.
        const lq = r.is_bot === null ? undefined
          : { is_bot: r.is_bot, typing_at: r.typing_at,
              responds_at: r.responds_at, arrives_at: r.arrives_at };
        const { is_bot, typing_at, responds_at, ...boat } = r;
        return {
          ...boat,
          live_state: liveStateFrom(lq, r.status),
          departs_in: departsInSeconds(lq),
        };
      });

      return reply.send({ boats });
    },
  );

  // ── GET /users/me/archive ──────────────────────────────────────────────────
  // Museu do Porto: um quadro por barco arquivado, do mais recente ao mais
  // antigo. Só os números do quadro — as mensagens vêm no pergaminho
  // (GET /boats/:id/scroll).
  app.get(
    '/users/me/archive',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const { rows } = await pool.query(
        `SELECT
           b.id, b.stage, b.unique_countries, b.total_nm, b.archive_reason,
           b.created_at, b.archived_at, b.final_note,
           EXTRACT(DAY FROM b.archived_at - b.created_at)::int AS days_at_sea,
           (SELECT COUNT(*)::int FROM boat_messages WHERE boat_id = b.id) AS message_count,
           (SELECT COUNT(*)::int FROM boat_messages
             WHERE boat_id = b.id AND gift_id IS NOT NULL)                AS gift_count,
           LEFT(bm.content, 80) AS initial_message
         FROM boats b
         JOIN boat_messages bm
           ON bm.boat_id = b.id
           AND bm.created_at = (
             SELECT MIN(created_at) FROM boat_messages WHERE boat_id = b.id
           )
         WHERE b.creator_user_id = $1 AND b.status = 'archived'
         ORDER BY b.archived_at DESC NULLS LAST`,
        [userId],
      );

      const boats = rows.map((r) => ({
        ...r,
        reason_label: REASON_LABEL[(r.archive_reason ?? 'perdido') as ArchiveReason],
      }));
      return reply.send({ boats });
    },
  );

  // ── GET /users/me/queue ────────────────────────────────────────────────────
  // Returns the current pending boat for this receiver (if any)
  app.get(
    '/users/me/queue',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const { rows } = await pool.query(
        `SELECT
           rq.id AS queue_id,
           rq.boat_id,
           rq.queued_at,
           rq.expires_at,
           b.stage,
           b.unique_countries,
           -- message history
           -- mais recente em cima, mais antiga embaixo (de onde o barco vem)
           COALESCE(
             json_agg(
               json_build_object(
                 'country_code', bm.country_code,
                 'content', bm.content,
                 'created_at', bm.created_at,
                 'gift_id', bm.gift_id
               ) ORDER BY bm.created_at DESC
             ) FILTER (WHERE bm.id IS NOT NULL),
             '[]'
           ) AS messages
         FROM receiver_queue rq
         JOIN boats b ON b.id = rq.boat_id
         LEFT JOIN boat_messages bm ON bm.boat_id = rq.boat_id
         WHERE rq.user_id = $1
           AND rq.status = 'pending'
           AND rq.arrives_at <= NOW()
           AND rq.expires_at > NOW()
         GROUP BY rq.id, b.id
         ORDER BY rq.queued_at ASC
         LIMIT 1`,
        [userId],
      );

      const boat = rows[0] ?? null;
      if (boat && Array.isArray(boat.messages)) {
        // resolve o presente de cada mensagem (emoji + nome)
        boat.messages = boat.messages.map((m: any) => ({
          ...m, gift: giftInfo(m.gift_id ?? null),
        }));
      }

      // barco navegando até a pessoa (ainda não atracou) → silhueta no horizonte
      let incoming: { secondsUntil: number; totalSeconds: number } | null = null;
      if (!boat) {
        const { rows: inc } = await pool.query(
          `SELECT
             GREATEST(EXTRACT(EPOCH FROM (arrives_at - NOW()))::int, 0) AS secs_until,
             GREATEST(EXTRACT(EPOCH FROM (arrives_at - queued_at))::int, 1) AS total_secs
           FROM receiver_queue
           WHERE user_id = $1 AND status = 'pending'
             AND arrives_at > NOW() AND expires_at > NOW()
           ORDER BY arrives_at ASC
           LIMIT 1`,
          [userId],
        );
        if (inc[0]) incoming = { secondsUntil: inc[0].secs_until, totalSeconds: inc[0].total_secs };
      }

      return reply.send({ boat, incoming });
    },
  );

  // ── GET /stats ─────────────────────────────────────────────────────────────
  // Números da porta de entrada. Públicos e REAIS — a página inicial não
  // inventa comunidade. Cache de 5 min: são contagens caras e que mudam devagar.
  let statsCache: { at: number; data: any } | null = null;
  app.get('/stats', {}, async (_req, reply) => {
    if (statsCache && Date.now() - statsCache.at < 5 * 60_000) {
      return reply.send(statsCache.data);
    }
    const [msgs, countries, boats, miles] = await Promise.all([
      pool.query(`SELECT COUNT(*) c FROM boat_messages`),
      pool.query(`SELECT COUNT(DISTINCT country_code) c FROM boat_countries`),
      pool.query(`SELECT COUNT(*) c FROM boats WHERE status = 'active'`),
      // soma das pernas de cada viagem, porto a porto
      pool.query(`
        WITH pares AS (
          SELECT h.boat_id, c.lat, c.lon,
                 LAG(c.lat) OVER (PARTITION BY h.boat_id ORDER BY h.hopped_at) plat,
                 LAG(c.lon) OVER (PARTITION BY h.boat_id ORDER BY h.hopped_at) plon
          FROM boat_hops h JOIN countries c ON c.code = h.country_code
          WHERE c.lat IS NOT NULL)
        SELECT COALESCE(ROUND(SUM(2 * 6371 * ASIN(SQRT(
                 POWER(SIN(RADIANS(lat - plat) / 2), 2) +
                 COS(RADIANS(plat)) * COS(RADIANS(lat)) *
                 POWER(SIN(RADIANS(lon - plon) / 2), 2)))) / 1.852), 0) c
        FROM pares WHERE plat IS NOT NULL`),
    ]);
    const data = {
      messages:      Number(msgs.rows[0].c),
      countries:     Number(countries.rows[0].c),
      boatsAtSea:    Number(boats.rows[0].c),
      nauticalMiles: Number(miles.rows[0].c),
    };
    statsCache = { at: Date.now(), data };
    return reply.send(data);
  });

  // ── GET /countries ─────────────────────────────────────────────────────────
  // Lista para o seletor de país. Só os ativos: o admin desliga países onde o
  // app não deve operar, e eles não podem aparecer como opção.
  app.get('/countries', {}, async (_req, reply) => {
    const { rows } = await pool.query(
      `SELECT code, name_pt AS name FROM countries WHERE active ORDER BY name_pt`,
    );
    return reply.send({ countries: rows });
  });

  // ── País do usuário ────────────────────────────────────────────────────────
  // O país sai do IP (ver services/geo.ts). Quando o IP não entrega nada, fica
  // 'XX' e a pessoa perde coisas silenciosamente: o horizonte fica vazio e as
  // mensagens dela são carimbadas com 🌍. Aqui ela conserta isso à mão.
  app.get('/users/me/country', {}, async (req, reply) => {
    const userId = (req as any).user?.id;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const { rows } = await pool.query(
      `SELECT u.country_code, (c.code IS NOT NULL) AS known
       FROM users u LEFT JOIN countries c ON c.code = u.country_code AND c.active
       WHERE u.id = $1`,
      [userId],
    );
    const country = rows[0]?.country_code ?? null;
    return reply.send({ country, needsPick: !rows[0]?.known });
  });

  app.post<{ Body: { country: string } }>(
    '/users/me/country',
    { schema: { body: { type: 'object', required: ['country'], properties: {
      country: { type: 'string', minLength: 2, maxLength: 2 },
    } } } },
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const code = req.body.country.toUpperCase();
      const { rows: valid } = await pool.query(
        `SELECT code FROM countries WHERE code = $1 AND active`, [code],
      );
      if (!valid.length) return reply.code(400).send({ error: 'país desconhecido' });

      // Só quem está sem país escolhe. Se o IP já disse de onde a pessoa fala,
      // trocar à mão viraria uma forma de forjar bandeira e inflar a contagem
      // de países dos barcos.
      const { rows: cur } = await pool.query(
        `SELECT u.email, u.role, (c.code IS NOT NULL) AS known
         FROM users u LEFT JOIN countries c ON c.code = u.country_code AND c.active
         WHERE u.id = $1`,
        [userId],
      );
      if (!cur.length) return reply.code(404).send({ error: 'usuário não encontrado' });
      if (cur[0].known) return reply.code(409).send({ error: 'seu país já está definido' });

      await pool.query(`UPDATE users SET country_code = $1 WHERE id = $2`, [code, userId]);

      // Token novo: o país viaja dentro dele e é o que carimba as mensagens
      // (ver routes/boats.ts). Sem isso, a correção só valeria no próximo login.
      const token = app.jwt.sign({
        id: userId, email: cur[0].email, country: code, role: cur[0].role,
      });
      return reply.send({ country: code, token });
    },
  );

  // ── GET /users/me/horizon ──────────────────────────────────────────────────
  // Os barcos que estão no mar agora, vistos do convés de quem pergunta:
  // distância e marcação, nada mais (ver services/horizon.ts).
  app.get(
    '/users/me/horizon',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      return reply.send(await horizonFor(userId));
    },
  );

  // ── GET /users/me/missed ───────────────────────────────────────────────────
  // Quantos barcos passaram (expiraram na fila) desde o último "visto"
  app.get(
    '/users/me/missed',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM receiver_queue rq
         JOIN users u ON u.id = rq.user_id
         WHERE rq.user_id = $1
           AND rq.status = 'expired'
           AND rq.expires_at > u.missed_seen_at`,
        [userId],
      );
      return reply.send({ count: rows[0]?.count ?? 0 });
    },
  );

  // ── GET /users/me/boat-gifts ───────────────────────────────────────────────
  // Presentes novos deixados nos barcos que EU criei (aviso ao criador)
  app.get(
    '/users/me/boat-gifts',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const { rows } = await pool.query(
        `WITH me AS (SELECT gifts_seen_at FROM users WHERE id = $1)
         SELECT
           (SELECT COUNT(*)::int
              FROM boat_messages bm JOIN boats b ON b.id = bm.boat_id, me
             WHERE b.creator_user_id = $1 AND bm.gift_id IS NOT NULL
               AND bm.user_id <> $1 AND bm.created_at > me.gifts_seen_at) AS count,
           (SELECT bm.boat_id
              FROM boat_messages bm JOIN boats b ON b.id = bm.boat_id, me
             WHERE b.creator_user_id = $1 AND bm.gift_id IS NOT NULL
               AND bm.user_id <> $1 AND bm.created_at > me.gifts_seen_at
             ORDER BY bm.created_at DESC LIMIT 1) AS latest_boat_id`,
        [userId],
      );
      return reply.send({ count: rows[0]?.count ?? 0, latestBoatId: rows[0]?.latest_boat_id ?? null });
    },
  );

  // ── POST /users/me/boat-gifts/ack ──────────────────────────────────────────
  app.post(
    '/users/me/boat-gifts/ack',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      await pool.query(`UPDATE users SET gifts_seen_at = NOW() WHERE id = $1`, [userId]);
      return reply.send({ status: 'ok' });
    },
  );

  // ── GET /users/me/celebrations ─────────────────────────────────────────────
  //
  // O que ainda merece festa. Dois tipos, na mesma fila, do mais antigo para o
  // mais novo — a ordem importa: quem abre o app depois de dois dias vê a
  // história na ordem em que aconteceu, não embaralhada.
  //
  //   presente  um estranho deixou um presente num barco meu
  //   evolucao  um barco meu subiu de nível
  //
  // O corte de cada um vem de um rastro diferente: presente é relógio
  // (users.gifts_seen_at), evolução é nível por barco (boats.stage_seen).
  app.get(
    '/users/me/celebrations',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      // ── presentes novos, um por um (não a contagem)
      const { rows: presentes } = await pool.query(
        `SELECT bm.id            AS message_id,
                bm.boat_id,
                bm.gift_id,
                bm.country_code,
                bm.content,
                bm.created_at,
                b.stage,
                LEFT(b.id::text, 5) AS boat_code
           FROM boat_messages bm
           JOIN boats b ON b.id = bm.boat_id
           JOIN users u ON u.id = $1
          WHERE b.creator_user_id = $1
            AND bm.gift_id IS NOT NULL
            AND bm.user_id <> $1
            AND bm.created_at > u.gifts_seen_at
          ORDER BY bm.created_at ASC
          LIMIT 12`,
        [userId],
      );

      // o baú do BARCO: tudo que ele já recebeu, para a tela mostrar a coleção
      // com o recém-chegado em destaque
      const baus = new Map<string, { id: string; name: string; emoji: string; quantos: number }[]>();
      for (const p of presentes) {
        if (baus.has(p.boat_id)) continue;
        const { rows } = await pool.query(
          `SELECT gift_id, COUNT(*)::int AS quantos
             FROM boat_messages
            WHERE boat_id = $1 AND gift_id IS NOT NULL
            GROUP BY gift_id
            ORDER BY COUNT(*) DESC`,
          [p.boat_id],
        );
        baus.set(p.boat_id, rows.map((r) => {
          const g = giftInfo(r.gift_id);
          return { id: r.gift_id, name: g?.name ?? r.gift_id, emoji: g?.emoji ?? '🎁', quantos: r.quantos };
        }));
      }

      // ── barcos que subiram de nível e ninguém comemorou
      // `initial_message` NÃO é coluna de `boats` — em todo o resto do código
      // ela é apelido de uma subconsulta na primeira mensagem do barco. Aqui
      // estava escrita como se fosse coluna, e o Postgres recusa a consulta
      // inteira antes de olhar uma linha sequer: a rota devolvia 500 para
      // todo mundo, sempre, desde que foi escrita. Nenhuma comemoração de
      // evolução jamais chegou a uma tela. Achado pelo rastro (033) no
      // primeiro dia em que ele existiu.
      const { rows: evolucoes } = await pool.query(
        `SELECT b.id AS boat_id, LEFT(b.id::text, 5) AS boat_code,
                b.stage, COALESCE(b.stage_seen, 1) AS stage_seen, b.last_hop_at,
                (SELECT LEFT(content, 80) FROM boat_messages
                  WHERE boat_id = b.id ORDER BY created_at ASC LIMIT 1) AS initial_message
           FROM boats b
          WHERE b.creator_user_id = $1
            AND b.status <> 'archived'
            AND b.stage > COALESCE(b.stage_seen, 1)
          ORDER BY b.last_hop_at ASC`,
        [userId],
      );

      // Uma comemoração de presente pode reaparecer se o "vi" não chegou ao
      // servidor. Marcando quais já foram agradecidos, o botão não convida a
      // repetir o que o banco vai recusar de qualquer forma.
      const agradecidos = await jaAgradecidos(userId, presentes.map((p) => p.message_id));

      const fila = [
        ...presentes.map((p) => {
          const g = giftInfo(p.gift_id);
          return {
            tipo: 'presente' as const,
            jaAgradeci: agradecidos.has(p.message_id),
            quando: p.created_at,
            boatId: p.boat_id,
            boatCode: p.boat_code,
            stage: p.stage,
            countryCode: p.country_code,
            mensagem: p.content as string | null,
            messageId: p.message_id,
            gift: { id: p.gift_id, name: g?.name ?? p.gift_id, emoji: g?.emoji ?? '🎁' },
            bau: baus.get(p.boat_id) ?? [],
          };
        }),
        ...evolucoes.map((e) => ({
          tipo: 'evolucao' as const,
          quando: e.last_hop_at,
          boatId: e.boat_id,
          boatCode: e.boat_code,
          de: e.stage_seen as number,
          para: e.stage as number,
          initialMessage: e.initial_message as string,
        })),
      ].sort((a, b) => new Date(a.quando).getTime() - new Date(b.quando).getTime());

      return reply.send({ celebracoes: fila });
    },
  );

  // ── POST /users/me/celebrations/ack ────────────────────────────────────────
  //
  // Uma comemoração por vez, conforme a pessoa fecha. Acusar em bloco seria
  // mais simples e apagaria o que chegou entre a consulta e o fechamento.
  app.post<{ Body: { giftUntil?: string; giftMessageId?: string; boatId?: string; stage?: number } }>(
    '/users/me/celebrations/ack',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      const { giftUntil, giftMessageId, boatId, stage } = req.body ?? {};

      // ── O corte dos presentes ────────────────────────────────────────────
      //
      // Era o app que mandava o relógio de volta (`giftUntil`), e isso não
      // funciona: JavaScript tem MILISSEGUNDO, Postgres tem MICROSSEGUNDO. Um
      // presente gravado às 06:22:01.087456 volta em JSON como 06:22:01.087,
      // o servidor guardava esse valor, e `created_at > gifts_seen_at`
      // continuava verdadeiro por 456 microssegundos — para sempre. A mesma
      // comemoração reaparecia a cada abertura do app, inclusive já marcada
      // como agradecida, porque agradecer e "ter visto" são coisas diferentes.
      //
      // Agora o app manda o ID da mensagem e o corte sai do banco, com a
      // precisão que o banco tem. De quebra, some a confiança no relógio de
      // quem chama: antes dava para mandar qualquer data.
      if (giftMessageId) {
        await pool.query(
          // O JOIN prende a mensagem a um barco DESTA pessoa: sem ele,
          // mandar o id de um presente alheio moveria o relógio dela.
          `UPDATE users u
              SET gifts_seen_at = GREATEST(u.gifts_seen_at, bm.created_at)
             FROM boat_messages bm
             JOIN boats b ON b.id = bm.boat_id
            WHERE u.id = $1 AND bm.id = $2 AND b.creator_user_id = $1`,
          [userId, giftMessageId],
        );
      } else if (giftUntil) {
        // Caminho antigo, para o site que ainda estiver com a versão anterior
        // no ar. O milissegundo a mais cobre exatamente o que a conversão para
        // JSON trunca — no máximo 999 microssegundos.
        await pool.query(
          `UPDATE users
              SET gifts_seen_at = GREATEST(gifts_seen_at, $2::timestamptz + INTERVAL '1 millisecond')
            WHERE id = $1`,
          [userId, giftUntil],
        );
      }
      if (boatId && typeof stage === 'number') {
        await pool.query(
          `UPDATE boats SET stage_seen = GREATEST(COALESCE(stage_seen, 1), $3)
            WHERE id = $2 AND creator_user_id = $1`,
          [userId, boatId, stage],
        );
      }
      return reply.send({ status: 'ok' });
    },
  );

  // ── POST /users/me/thanks ──────────────────────────────────────────────────
  //
  // O obrigado por um presente. Frase PRONTA: o corpo traz a chave, nunca
  // texto. Chave desconhecida é recusada aqui, antes de chegar ao banco.
  app.post<{ Body: { messageId?: string; phrase?: string } }>(
    '/users/me/thanks',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const { messageId, phrase } = req.body ?? {};
      if (!messageId) return reply.code(400).send({ error: 'messageId obrigatório' });
      if (!fraseValida(phrase)) return reply.code(400).send({ error: 'frase inválida' });

      const r = await agradecer(userId, messageId, phrase);
      if (r === 'nao_encontrado') return reply.code(404).send({ error: 'presente não encontrado' });
      return reply.send({ status: r });
    },
  );

  // ── GET /users/me/notifications ────────────────────────────────────────────
  // A caixa de recados. Hoje só agradecimentos; o formato já é uma lista para
  // caber outro tipo depois sem mexer no app.
  app.get(
    '/users/me/notifications',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      return reply.send(await recadosDe(userId));
    },
  );

  app.post(
    '/users/me/notifications/ack',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });
      await marcarRecadosLidos(userId);
      return reply.send({ status: 'ok' });
    },
  );

  // ── POST /users/me/missed/ack ──────────────────────────────────────────────
  // Usuário viu o aviso — zera a contagem
  app.post(
    '/users/me/missed/ack',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      await pool.query(
        `UPDATE users SET missed_seen_at = NOW() WHERE id = $1`,
        [userId],
      );
      return reply.send({ status: 'ok' });
    },
  );
}
