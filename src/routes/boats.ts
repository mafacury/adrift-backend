import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/pool.js';
import { processModeration, processRouting } from '../services/process.js';
import { countryFromIp } from '../services/geo.js';
import { userOwnsGift } from '../services/gifts.js';
import { sendPushToUser, boatGiftMessage } from '../services/push.js';
import { config } from '../config/index.js';

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
      // Usa o país do JWT (detectado no login) ou faz fallback para IP atual
      const countryCode = (req as any).user?.country || await countryFromIp(req.ip);

      // valida o presente (se houver) — só o que o usuário destravou
      const gift = giftId && (await userOwnsGift(userId, giftId)) ? giftId : null;

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
             stage = CASE
               WHEN (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 50 THEN 6
               WHEN (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 35 THEN 5
               WHEN (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 20 THEN 4
               WHEN (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 10 THEN 3
               WHEN (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 4  THEN 2
               ELSE 1
             END,
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
            void sendPushToUser(creatorId, msg.title, msg.body);
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
        `SELECT id, creator_user_id, status, stage, unique_countries, created_at, last_hop_at
         FROM boats WHERE id = $1`,
        [boatId],
      );
      if (!boatRows.length) return reply.code(404).send({ error: 'boat not found' });
      const boat = boatRows[0];
      if (boat.creator_user_id !== userId) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      // Hop history with messages
      const { rows: hops } = await pool.query(
        `SELECT
           h.id,
           h.country_code,
           h.hopped_at,
           bm.content AS message,
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

      // Estado "ao vivo": há alguém com o barco agora? Está escrevendo?
      // Humanos: o app do receptor manda POST /boats/:id/typing enquanto a
      // pessoa digita (sinal real). Bots: o prazo de resposta é determinístico
      // (mesma fórmula do sweep em services/bots.ts), então dá para anunciar
      // "escrevendo..." nos minutos finais. Nunca revela país nem horário.
      const TYPING_WINDOW_MIN = 7;      // bots: minutos antes da resposta
      const TYPING_FRESH_SEC  = 45;     // humanos: validade do último sinal
      const { rows: liveRows } = await pool.query(
        `SELECT
           (u.oauth_provider = 'bot') AS is_bot,
           rq.typing_at,
           rq.queued_at + ((30 + ABS(HASHTEXT(rq.id::text)) % 211) || ' minutes')::interval AS responds_at
         FROM receiver_queue rq
         JOIN users u ON u.id = rq.user_id
         WHERE rq.boat_id = $1 AND rq.status = 'pending'
         ORDER BY rq.queued_at DESC
         LIMIT 1`,
        [boatId],
      );

      let liveState: 'idle' | 'sailing' | 'typing' =
        boat.status === 'active' ? 'sailing' : 'idle';
      if (liveRows.length) {
        const live = liveRows[0];
        if (live.is_bot) {
          const msLeft = new Date(live.responds_at).getTime() - Date.now();
          if (msLeft <= TYPING_WINDOW_MIN * 60_000) liveState = 'typing';
        } else if (
          live.typing_at &&
          Date.now() - new Date(live.typing_at).getTime() <= TYPING_FRESH_SEC * 1000
        ) {
          liveState = 'typing';
        }
      }

      return reply.send({ boat, hops, live: { state: liveState } });
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
