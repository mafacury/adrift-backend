import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { getAchievementsForUser } from '../services/achievements.js';

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
           LEFT(bm.content, 80) AS initial_message,
           (
             SELECT COUNT(DISTINCT user_id)
             FROM boat_country_interactions
             WHERE boat_id = b.id
           ) AS total_unique_interactions
         FROM boats b
         JOIN boat_messages bm
           ON bm.boat_id = b.id
           AND bm.created_at = (
             SELECT MIN(created_at) FROM boat_messages WHERE boat_id = b.id
           )
         WHERE b.creator_user_id = $1
         ORDER BY b.created_at DESC`,
        [userId],
      );

      return reply.send({ boats: rows });
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
           COALESCE(
             json_agg(
               json_build_object(
                 'country_code', bm.country_code,
                 'content', bm.content,
                 'created_at', bm.created_at
               ) ORDER BY bm.created_at ASC
             ) FILTER (WHERE bm.id IS NOT NULL),
             '[]'
           ) AS messages
         FROM receiver_queue rq
         JOIN boats b ON b.id = rq.boat_id
         LEFT JOIN boat_messages bm ON bm.boat_id = rq.boat_id
         WHERE rq.user_id = $1
           AND rq.status = 'pending'
           AND rq.expires_at > NOW()
         GROUP BY rq.id, b.id
         ORDER BY rq.queued_at ASC
         LIMIT 1`,
        [userId],
      );

      return reply.send({ boat: rows[0] ?? null });
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
