import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/pool.js';
import { processModeration, processRouting } from '../services/process.js';
import { countryFromIp } from '../services/geo.js';
import { userOwnsGift, giftInfo, consumeGift } from '../services/gifts.js';
import { liveStateFrom } from '../services/live.js';
import { greatCirclePoint, legProgress } from '../services/horizon.js';
import { STAGE_CASE_SQL } from '../services/progress.js';
import { startReturn, MIN_COUNTRIES_TO_RETURN } from '../services/journey.js';
import { boatGiftMessage } from '../services/push.js';
import { avisar } from '../services/notify.js';
import { config } from '../config/index.js';
import { traduzirMensagens } from '../services/translate.js';

interface CreateBoatBody {
  content: string;
  giftId?: string;
}

interface HopBody {
  content?: string;
  giftId?: string;
}

export async function boatRoutes(app: FastifyInstance) {
  // ── POST /boats ────────────────────────────────────────────────────────────
  app.post<{ Body: CreateBoatBody }>(
    '/boats',
    { schema: { body: { type: 'object', required: ['content'], properties: {
      content: { type: 'string', minLength: 1, maxLength: 500 },
      giftId:  { type: 'string', maxLength: 40 },
    } } } },
    async (req: FastifyRequest<{ Body: CreateBoatBody }>, reply: FastifyReply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const { content, giftId } = req.body;

      // ── Freio de lançamento ────────────────────────────────────────────────
      // Não existia teto nenhum: uma conta lançava barcos até cansar, e uma
      // fábrica de contas multiplicava isso. Dois limites, ambos folgados para
      // quem usa o app de verdade e ruinosos para quem despeja propaganda.
      const { rows: freio } = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM boats
             WHERE creator_user_id = $1 AND status = 'active')          AS ativos,
           (SELECT MAX(created_at) FROM boats
             WHERE creator_user_id = $1)                                AS ultimo`,
        [userId],
      );
      const ativos: number = freio[0]?.ativos ?? 0;
      const ultimo: Date | null = freio[0]?.ultimo ?? null;

      if (ativos >= config.antispam.maxActiveBoatsPerUser) {
        return reply.code(429).send({
          error: 'limite_de_barcos',
          message:
            `Você já tem ${ativos} barcos no mar. Espere um deles voltar ` +
            'para casa antes de lançar outro.',
        });
      }

      if (ultimo) {
        const esperaSeg = config.antispam.launchCooldownSec;
        const decorrido = (Date.now() - new Date(ultimo).getTime()) / 1000;
        if (decorrido < esperaSeg) {
          const faltam = Math.ceil(esperaSeg - decorrido);
          return reply.code(429).send({
            error: 'aguarde',
            message:
              'Um barco de cada vez. Espere ' +
              (faltam >= 60 ? `${Math.ceil(faltam / 60)} minuto(s)` : `${faltam} segundos`) +
              ' para lançar o próximo.',
            retryAfterSec: faltam,
          });
        }
      }

      // Usa o país do JWT (detectado no login) ou faz fallback para IP atual
      const countryCode = (req as any).user?.country || await countryFromIp(req.ip);

      // valida o presente (se houver) — só o que o usuário destravou
      const gift = giftId && (await userOwnsGift(userId, giftId)) ? giftId : null;
      // sai do bau agora: presente que nao gasta nada nao vale nada
      if (gift) await consumeGift(userId, gift);

      // Create boat + first message in one transaction
      const { rows } = await pool.query('BEGIN; SELECT 1');
      try {
        const boatResult = await pool.query(
          `INSERT INTO boats (creator_user_id) VALUES ($1) RETURNING id`,
          [userId],
        );
        const boatId: string = boatResult.rows[0].id;

        const msgResult = await pool.query(
          `INSERT INTO boat_messages (boat_id, user_id, content, country_code, gift_id)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [boatId, userId, content, countryCode, gift],
        );
        const messageId: string = msgResult.rows[0].id;

        await pool.query('COMMIT');

        // Moderação roda em background — resposta não espera
        void processModeration({ boatId, messageId, content, userId, countryCode });

        return reply.code(202).send({
          boatId,
          status: 'pending_moderation',
          message: 'Barcos viajam pelo oceano. Chegam quando chegam.',
        });
      } catch (err) {
        await pool.query('ROLLBACK');
        throw err;
      }
    },
  );

  // ── POST /boats/:id/hop ────────────────────────────────────────────────────
  // Receptor adds message (optional) and sends boat onward
  app.post<{ Params: { id: string }; Body: HopBody }>(
    '/boats/:id/hop',
    { schema: { body: { type: 'object', properties: {
      content: { type: 'string', minLength: 1, maxLength: 500 },
      giftId:  { type: 'string', maxLength: 40 },
    } } } },
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const boatId = req.params.id;
      const { content, giftId } = req.body ?? {};
      const ip = req.ip;
      const countryCode = await countryFromIp(ip);

      // presente só é anexado a uma mensagem — e só se o usuário o tiver
      const gift = content && giftId && (await userOwnsGift(userId, giftId)) ? giftId : null;
      if (gift) await consumeGift(userId, gift);

      // Verify the boat exists and is active, and this user has a pending queue entry
      const { rows: queueRows } = await pool.query(
        `SELECT id FROM receiver_queue
         WHERE boat_id = $1 AND user_id = $2 AND status = 'pending'
         LIMIT 1`,
        [boatId, userId],
      );
      if (!queueRows.length) {
        return reply.code(404).send({ error: 'boat not in your queue' });
      }

      await pool.query('BEGIN');
      try {
        // Mark queue entry delivered
        await pool.query(
          `UPDATE receiver_queue SET status = 'delivered'
           WHERE boat_id = $1 AND user_id = $2 AND status = 'pending'`,
          [boatId, userId],
        );

        let messageId: string | null = null;

        if (content) {
          const msgResult = await pool.query(
            `INSERT INTO boat_messages (boat_id, user_id, content, country_code, gift_id)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [boatId, userId, content, countryCode, gift],
          );
          messageId = msgResult.rows[0].id;
          // conteúdo novo = assunto vivo: zera o contador de "deixaram passar"
          await pool.query(`UPDATE boats SET idle_ignores = 0 WHERE id = $1`, [boatId]);
        }

        // Record hop immediately (receptor interacted — boat is "here" now)
        const { rows: prevHop } = await pool.query(
          `SELECT to_user_id FROM boat_hops WHERE boat_id = $1 ORDER BY hopped_at DESC LIMIT 1`,
          [boatId],
        );
        const fromUserId = prevHop[0]?.to_user_id ?? null;

        // Insert hop
        await pool.query(
          `INSERT INTO boat_hops (boat_id, from_user_id, to_user_id, country_code, message_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [boatId, fromUserId, userId, countryCode, messageId],
        );

        // Update boat_countries + stage
        await pool.query(
          `INSERT INTO boat_countries (boat_id, country_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [boatId, countryCode],
        );
        if (messageId) {
          await pool.query(
            `INSERT INTO boat_country_interactions (boat_id, country_code, user_id)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [boatId, countryCode, userId],
          );
        }
        await pool.query(
          `UPDATE boats
           SET
             unique_countries = (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1),
             stage = ${STAGE_CASE_SQL},
             last_hop_at = NOW()
           WHERE id = $1`,
          [boatId],
        );

        await pool.query('COMMIT');

        // Deixou um presente? Avisa o criador do barco (se não for ele mesmo).
        if (gift) {
          const { rows: cr } = await pool.query(
            `SELECT creator_user_id FROM boats WHERE id = $1`, [boatId],
          );
          const creatorId = cr[0]?.creator_user_id;
          if (creatorId && creatorId !== userId) {
            const msg = boatGiftMessage();
            void avisar(creatorId, { titulo: msg.title, corpo: msg.body, url: '/map', tag: 'presente' });
          }
        }

        if (content && messageId) {
          // Nova mensagem — modera antes de rotear (em background)
          void processModeration({ boatId, messageId, content, userId, countryCode });
        } else {
          // Sem mensagem nova — rotear direto (em background)
          void processRouting({ boatId, fromUserId: userId });
        }

        return reply.send({ status: 'sailing' });
      } catch (err) {
        await pool.query('ROLLBACK');
        throw err;
      }
    },
  );

  // ── POST /boats/:id/translate ──────────────────────────────────────────────
  // Traduz as mensagens do barco para o português. Só a pedido: as mensagens
  // chegam em japonês, italiano, suaíli, e quem recebe quer entender antes de
  // responder — mas o original é a mensagem, e ele nunca é substituído sem que
  // a pessoa peça.
  app.post<{ Params: { id: string } }>(
    '/boats/:id/translate',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      // Só quem tem alguma ligação com este barco pode pedir a tradução dele —
      // senão bastaria adivinhar um id para ler o barco de outra pessoa.
      // São três os vínculos legítimos, e o primeiro é o mais óbvio de esquecer:
      // o DONO não tem linha na fila de recebimento do próprio barco, então a
      // versão anterior recusava traduzir o barco de quem o lançou.
      const { rows: pode } = await pool.query(
        `SELECT 1 WHERE
           EXISTS (SELECT 1 FROM boats
                    WHERE id = $1 AND creator_user_id = $2)
           OR EXISTS (SELECT 1 FROM receiver_queue
                       WHERE boat_id = $1 AND user_id = $2)
           OR EXISTS (SELECT 1 FROM boat_messages
                       WHERE boat_id = $1 AND user_id = $2)`,
        [req.params.id, userId],
      );
      if (pode.length === 0) return reply.code(404).send({ error: 'not_found' });

      // MESMA ordem da fila (created_at DESC): é o índice que liga cada
      // tradução à mensagem na tela
      const { rows: msgs } = await pool.query(
        `SELECT content FROM boat_messages
          WHERE boat_id = $1
          ORDER BY created_at DESC`,
        [req.params.id],
      );

      const traducoes = await traduzirMensagens(msgs.map(m => m.content as string));
      return reply.send({ translations: traducoes });
    },
  );

  // ── POST /boats/:id/ignore ─────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/boats/:id/ignore',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const boatId = req.params.id;

      await pool.query('BEGIN');
      try {
        // Mark queue entry skipped
        await pool.query(
          `UPDATE receiver_queue SET status = 'skipped'
           WHERE boat_id = $1 AND user_id = $2 AND status = 'pending'`,
          [boatId, userId],
        );

        // Upsert ignore count
        await pool.query(
          `INSERT INTO boat_ignore_counts (boat_id, user_id, count)
           VALUES ($1, $2, 1)
           ON CONFLICT (boat_id, user_id) DO UPDATE SET count = boat_ignore_counts.count + 1`,
          [boatId, userId],
        );

        // "Deixaram passar" SEGUIDOS — o sinal de que o assunto se esgotou.
        // Qualquer mensagem nova zera; chegando a MAX_IDLE_IGNORES o barco
        // volta para casa (services/journey.ts).
        await pool.query(
          `UPDATE boats SET idle_ignores = idle_ignores + 1 WHERE id = $1`,
          [boatId],
        );

        await pool.query('COMMIT');

        // Re-route to someone else (em background)
        void processRouting({ boatId, fromUserId: null });

        return reply.send({ status: 'ignored' });
      } catch (err) {
        await pool.query('ROLLBACK');
        throw err;
      }
    },
  );

  // ── POST /boats/:id/return ─────────────────────────────────────────────────
  // "Chamar de volta": encerra a jornada por escolha do dono. O barco para de
  // receber mensagens na hora e navega de volta em TEMPO REAL (1 a 5 dias,
  // pela distância). Não dá para cancelar — é isso que dá peso à decisão.
  app.post<{ Params: { id: string } }>(
    '/boats/:id/return',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const { rows } = await pool.query(
        `SELECT creator_user_id, status, unique_countries FROM boats WHERE id = $1`,
        [req.params.id],
      );
      if (!rows.length) return reply.code(404).send({ error: 'boat not found' });
      const boat = rows[0];

      if (boat.creator_user_id !== userId) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      if (boat.status === 'returning') {
        return reply.code(409).send({ error: 'already_returning' });
      }
      if (boat.status !== 'active') {
        return reply.code(409).send({ error: 'not_active' });
      }
      if (boat.unique_countries < MIN_COUNTRIES_TO_RETURN) {
        return reply.code(409).send({
          error: 'too_early',
          minCountries: MIN_COUNTRIES_TO_RETURN,
        });
      }

      const { arrivesHomeAt } = await startReturn(req.params.id, 'chamado');
      return reply.send({ status: 'returning', arrives_home_at: arrivesHomeAt });
    },
  );

  // ── POST /boats/:id/final-note ─────────────────────────────────────────────
  // A última página do diário: a despedida que o dono escreve quando o barco
  // atraca. Opcional — a jornada começou com uma mensagem dele e termina com
  // uma mensagem dele.
  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/boats/:id/final-note',
    {
      schema: {
        body: {
          type: 'object',
          properties: { note: { type: 'string', maxLength: 500 } },
        },
      },
    },
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const note = (req.body?.note ?? '').trim();
      const { rowCount } = await pool.query(
        `UPDATE boats SET final_note = $3
         WHERE id = $1 AND creator_user_id = $2 AND status = 'archived'`,
        [req.params.id, userId, note || null],
      );
      if (!rowCount) return reply.code(404).send({ error: 'boat not found' });
      return reply.send({ status: 'ok' });
    },
  );

  // ── POST /boats/:id/typing ─────────────────────────────────────────────────
  // Receptor humano avisa que está digitando a resposta — o criador do barco
  // vê "escrevendo..." ao vivo no mapa. O app manda o sinal a cada ~10 s.
  app.post<{ Params: { id: string } }>(
    '/boats/:id/typing',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      await pool.query(
        `UPDATE receiver_queue SET typing_at = NOW()
         WHERE boat_id = $1 AND user_id = $2 AND status = 'pending'`,
        [req.params.id, userId],
      );
      return reply.send({ status: 'ok' });
    },
  );

  // ── GET /boats/:id/route ───────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/boats/:id/route',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const boatId = req.params.id;

      // Only the creator can see the full route
      const { rows: boatRows } = await pool.query(
        `SELECT id, creator_user_id, status, stage, unique_countries, created_at, last_hop_at,
                returning_at, arrives_home_at, archived_at, archive_reason,
                final_note, total_nm,
                unique_countries >= ${MIN_COUNTRIES_TO_RETURN} AS can_return
         FROM boats WHERE id = $1`,
        [boatId],
      );
      if (!boatRows.length) return reply.code(404).send({ error: 'boat not found' });
      const boat = boatRows[0];
      if (boat.creator_user_id !== userId) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      // O lançamento é o "ponto 1" da jornada: país e mensagem inicial do
      // criador entram como primeiro item, antes dos pulos reais — assim o
      // barco aparece no mapa desde o momento em que é lançado.
      const { rows: firstMsg } = await pool.query(
        `SELECT country_code, content, gift_id FROM boat_messages
         WHERE boat_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [boatId],
      );

      // Hop history with messages
      const { rows: hops } = await pool.query(
        `SELECT
           h.id,
           h.country_code,
           h.hopped_at,
           bm.content AS message,
           bm.gift_id,
           bci.interaction_count
         FROM boat_hops h
         LEFT JOIN boat_messages bm ON bm.id = h.message_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS interaction_count
           FROM boat_country_interactions
           WHERE boat_id = $1 AND country_code = h.country_code
         ) bci ON TRUE
         WHERE h.boat_id = $1
         ORDER BY h.hopped_at ASC`,
        [boatId],
      );

      if (firstMsg.length) {
        hops.unshift({
          id: `launch-${boatId}`,
          country_code: firstMsg[0].country_code,
          hopped_at: boat.created_at,
          message: firstMsg[0].content,
          gift_id: firstMsg[0].gift_id,
          interaction_count: 0,
        });
      }

      // Estado "ao vivo" (ver services/live.ts): humanos = sinal real de
      // digitação; bots = prazo determinístico. Não revela país nem horário.
      const { rows: liveRows } = await pool.query(
        `SELECT
           (u.oauth_provider = 'bot') AS is_bot,
           rq.typing_at,
           rq.arrives_at,
           rq.queued_at,
           -- pontas da travessia, só para calcular ONDE ele está agora;
           -- o destino não sai daqui (ver o objeto leg montado abaixo)
           COALESCE(oh.lat, om.lat) AS o_lat,
           COALESCE(oh.lon, om.lon) AS o_lon,
           dc.lat AS d_lat,
           dc.lon AS d_lon,
           -- prazo efetivo do bot: chegada + leitura (5..45min) OU pouco
           -- antes de a fila expirar — o que vier primeiro
           LEAST(
             rq.arrives_at + ((5 + ABS(HASHTEXT(rq.id::text)) % 41) || ' minutes')::interval,
             rq.expires_at - INTERVAL '2 minutes'
           ) AS responds_at
         FROM receiver_queue rq
         JOIN users u ON u.id = rq.user_id
         LEFT JOIN countries dc ON dc.code = COALESCE(rq.dest_country, u.country_code)
         -- porto de partida: o último pulo antes de zarpar
         LEFT JOIN LATERAL (
           SELECT c.lat, c.lon
           FROM boat_hops h JOIN countries c ON c.code = h.country_code
           WHERE h.boat_id = rq.boat_id AND h.hopped_at <= rq.queued_at
           ORDER BY h.hopped_at DESC LIMIT 1
         ) oh ON TRUE
         -- barco que ainda não pulou: parte de onde foi lançado
         LEFT JOIN LATERAL (
           SELECT c.lat, c.lon
           FROM boat_messages m JOIN countries c ON c.code = m.country_code
           WHERE m.boat_id = rq.boat_id
           ORDER BY m.created_at ASC LIMIT 1
         ) om ON TRUE
         WHERE rq.boat_id = $1 AND rq.status = 'pending'
         ORDER BY rq.queued_at DESC
         LIMIT 1`,
        [boatId],
      );

      // Resolve o código do presente no catálogo (nome + emoji) para o painel
      // do mapa mostrar o presente AO LADO da mensagem em que foi deixado.
      const hopsWithGifts = hops.map(({ gift_id, ...h }) => ({
        ...h,
        gift: giftInfo(gift_id ?? null),
      }));

      // Onde o barco está AGORA. Serve para o mapa desenhar a travessia se
      // preenchendo em vez de deixar o barco parado no porto por horas.
      //
      // DURANTE a travessia sai a posição e o relógio, nunca o destino: quem
      // recebe é surpresa, e a linha some na bruma adiante do casco. Nem a
      // FRAÇÃO sai — com a partida (que é pública), a posição e a fração, uma
      // regra de três devolveria o ponto de chegada.
      //
      // DEPOIS de atracar, o barco fica no porto de destino, e aí o país sai
      // sim. Antes ele não saía, e o mapa fazia coisa pior que revelar: sem
      // posição, o desenho caía no último pulo — o porto de ONDE ELE PARTIU. O
      // barco voltava várias paradas para trás no instante em que chegava,
      // ficava lá enquanto alguém escrevia, e só então saltava para o porto
      // novo. Mostrava um lugar errado para esconder o certo.
      //
      // O sigilo que se perde aqui é de minutos: assim que a pessoa devolve o
      // barco, o pulo aparece com o país — e mesmo quando ela não escreve
      // nada, o porto entra na lista como "passou sem escrever", com bandeira.
      const lr = liveRows[0];
      let leg: { lat: number; lon: number; etaSeconds: number; atracado?: boolean } | null = null;
      if (lr?.o_lat != null && lr?.d_lat != null && lr?.arrives_at) {
        const startedMs = new Date(lr.queued_at).getTime();
        const arrivesMs = new Date(lr.arrives_at).getTime();
        const now = Date.now();
        if (arrivesMs > now) {
          const f = legProgress(startedMs, arrivesMs, now);
          const p = greatCirclePoint(
            Number(lr.o_lat), Number(lr.o_lon), Number(lr.d_lat), Number(lr.d_lon), f,
          );
          leg = {
            lat: Math.round(p.lat * 100) / 100,
            lon: Math.round(p.lon * 100) / 100,
            etaSeconds: Math.round((arrivesMs - now) / 1000),
          };
        } else {
          // chegou: o casco fica no destino até virar pulo
          leg = {
            lat: Math.round(Number(lr.d_lat) * 100) / 100,
            lon: Math.round(Number(lr.d_lon) * 100) / 100,
            etaSeconds: 0,
            atracado: true,
          };
        }
      }

      return reply.send({
        boat, hops: hopsWithGifts,
        live: { state: liveStateFrom(liveRows[0], boat.status) },
        leg,
      });
    },
  );

  // ── GET /rankings ──────────────────────────────────────────────────────────
  // Ranking de BARCOS (anônimo): pontos = interações (mensagens de terceiros)
  // + presentes recebidos × 10.
  //   scope=world    — barcos em alto-mar (mundial)
  //   scope=country  — barcos em alto-mar do país do criador
  //   scope=legends  — LENDAS: hall da fama permanente dos arquivados. Assim
  //                    aposentar um barco bem colocado o PROMOVE para a lista
  //                    eterna em vez de apagá-lo.
  // Barcos de bots/demo ficam de fora. Inclui a posição do melhor barco do
  // usuário logado, mesmo fora do Top 50.
  app.get<{ Querystring: { scope?: string } }>(
    '/rankings',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const legends = req.query.scope === 'legends';
      // Fragmento derivado de lista fechada — nunca de entrada do usuário.
      const statusSql = legends
        ? `b.status = 'archived' AND b.archive_reason IS DISTINCT FROM 'moderado'`
        : `b.status <> 'archived'`;

      let countryFilter: string | null = null;
      if (req.query.scope === 'country') {
        const { rows } = await pool.query(
          `SELECT country_code FROM users WHERE id = $1`, [userId],
        );
        countryFilter = rows[0]?.country_code ?? null;
      }

      const rankedSql = `
        WITH scored AS (
          SELECT
            b.id, b.stage, b.creator_user_id,
            b.archive_reason, b.total_nm, b.unique_countries,
            u.country_code,
            (SELECT LEFT(content, 60) FROM boat_messages
             WHERE boat_id = b.id ORDER BY created_at ASC LIMIT 1) AS initial_message,
            (SELECT COUNT(*)::int FROM boat_messages m
             WHERE m.boat_id = b.id AND m.user_id <> b.creator_user_id) AS interactions,
            (SELECT COUNT(*)::int FROM boat_messages m
             WHERE m.boat_id = b.id AND m.user_id <> b.creator_user_id
               AND m.gift_id IS NOT NULL) AS gifts
          FROM boats b
          JOIN users u ON u.id = b.creator_user_id
          WHERE u.oauth_provider IS DISTINCT FROM 'bot'
            AND ${statusSql}
            AND ($1::text IS NULL OR u.country_code = $1)
        ),
        ranked AS (
          SELECT *,
            interactions + gifts * 10 AS score,
            RANK() OVER (ORDER BY interactions + gifts * 10 DESC) AS pos
          FROM scored
        )`;

      const { rows: top } = await pool.query(
        `${rankedSql}
         SELECT pos, id, stage, country_code, initial_message,
                interactions, gifts, score,
                archive_reason, total_nm, unique_countries,
                (creator_user_id = $2) AS is_mine
         FROM ranked
         ORDER BY pos, id
         LIMIT 50`,
        [countryFilter, userId],
      );

      const { rows: mine } = await pool.query(
        `${rankedSql}
         SELECT pos, id FROM ranked
         WHERE creator_user_id = $2
         ORDER BY pos LIMIT 1`,
        [countryFilter, userId],
      );

      return reply.send({
        scope: legends ? 'legends' : countryFilter ? 'country' : 'world',
        country: countryFilter,
        rows: top,
        me: mine[0] ?? null,
      });
    },
  );

  // ── POST /boats/:id/report ─────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: { messageId: string } }>(
    '/boats/:id/report',
    { schema: { body: { type: 'object', required: ['messageId'], properties: {
      messageId: { type: 'string' },
    } } } },
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const boatId = req.params.id;
      const { messageId } = req.body;

      await pool.query(
        `INSERT INTO reports (boat_id, message_id, reporter_user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [boatId, messageId, userId],
      );

      // Check if MIN_REPORTS_TO_PAUSE threshold reached
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS count FROM reports WHERE message_id = $1`,
        [messageId],
      );
      if (parseInt(rows[0].count, 10) >= config.boat.minReportsToPause) {
        await pool.query(
          `UPDATE boats SET status = 'paused' WHERE id = $1`,
          [boatId],
        );
      }

      return reply.send({ status: 'reported' });
    },
  );
}
