import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';

export async function userRoutes(app: FastifyInstance) {
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
}
