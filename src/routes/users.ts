import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { getAchievementsForUser } from '../services/achievements.js';
import { getGiftsForUser, giftInfo } from '../services/gifts.js';
import { liveStateFrom, departsInSeconds } from '../services/live.js';
import { horizonFor } from '../services/horizon.js';
import { MIN_COUNTRIES_TO_RETURN, REASON_LABEL, ArchiveReason } from '../services/journey.js';

export async function userRoutes(app: FastifyInstance) {
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
        const lq = r.is_bot === null ? undefined
          : { is_bot: r.is_bot, typing_at: r.typing_at, responds_at: r.responds_at };
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
