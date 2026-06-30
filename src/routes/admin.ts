import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/pool.js';

// Middleware shared by all admin routes
async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const user = (req as any).user;
  if (!user?.id) return reply.code(401).send({ error: 'unauthorized' });
  if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
}

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin);

  // ── GET /admin/stats ───────────────────────────────────────────────────────
  app.get('/admin/stats', async (_req, reply) => {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users)                                         AS total_users,
        (SELECT COUNT(*)::int FROM users WHERE ban_status = 'banned')             AS banned_users,
        (SELECT COUNT(*)::int FROM boats WHERE status = 'active')                 AS active_boats,
        (SELECT COUNT(*)::int FROM boats)                                         AS total_boats,
        (SELECT COUNT(*)::int FROM boat_messages)                                 AS total_messages,
        (SELECT COUNT(*)::int FROM boat_messages
           WHERE created_at > NOW() - INTERVAL '24 hours')                        AS messages_today,
        (SELECT COUNT(*)::int FROM reports)                                       AS total_reports,
        (SELECT COUNT(*)::int FROM users
           WHERE created_at > NOW() - INTERVAL '7 days')                          AS new_users_week
    `);
    return reply.send(rows[0]);
  });

  // ── GET /admin/users ───────────────────────────────────────────────────────
  app.get<{ Querystring: { page?: string; limit?: string; search?: string; status?: string } }>(
    '/admin/users',
    async (req, reply) => {
      const page   = Math.max(1, parseInt(req.query.page  ?? '1', 10));
      const limit  = Math.min(50, parseInt(req.query.limit ?? '20', 10));
      const offset = (page - 1) * limit;
      const search = req.query.search ?? null;
      const status = req.query.status ?? null;

      const { rows } = await pool.query(
        `SELECT
           u.id, u.email, u.country_code, u.reputation_score,
           u.ban_status, u.role, u.created_at, u.last_active_at,
           (SELECT COUNT(*)::int FROM boats WHERE creator_user_id = u.id) AS boat_count
         FROM users u
         WHERE ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%')
           AND ($2::text IS NULL OR u.ban_status = $2)
         ORDER BY u.created_at DESC
         LIMIT $3 OFFSET $4`,
        [search, status, limit, offset],
      );

      const { rows: cnt } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM users
         WHERE ($1::text IS NULL OR email ILIKE '%' || $1 || '%')
           AND ($2::text IS NULL OR ban_status = $2)`,
        [search, status],
      );

      return reply.send({ users: rows, total: cnt[0].total, page, limit });
    },
  );

  // ── PATCH /admin/users/:id ─────────────────────────────────────────────────
  app.patch<{ Params: { id: string }; Body: { ban_status?: string; role?: string } }>(
    '/admin/users/:id',
    async (req, reply) => {
      const { id } = req.params;
      const { ban_status, role } = req.body ?? {};

      if (ban_status) {
        if (!['active','warned','banned'].includes(ban_status))
          return reply.code(400).send({ error: 'ban_status inválido' });
        await pool.query('UPDATE users SET ban_status = $1 WHERE id = $2', [ban_status, id]);
      }
      if (role) {
        if (!['user','admin'].includes(role))
          return reply.code(400).send({ error: 'role inválido' });
        await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
      }

      return reply.send({ status: 'ok' });
    },
  );

  // ── DELETE /admin/users/:id ────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/admin/users/:id',
    async (req, reply) => {
      await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
      return reply.send({ status: 'ok' });
    },
  );

  // ── GET /admin/boats ───────────────────────────────────────────────────────
  app.get<{ Querystring: { page?: string; limit?: string; status?: string } }>(
    '/admin/boats',
    async (req, reply) => {
      const page   = Math.max(1, parseInt(req.query.page  ?? '1', 10));
      const limit  = Math.min(50, parseInt(req.query.limit ?? '20', 10));
      const offset = (page - 1) * limit;
      const status = req.query.status ?? null;

      const { rows } = await pool.query(
        `SELECT
           b.id, b.status, b.stage, b.unique_countries, b.created_at, b.last_hop_at,
           u.email AS creator_email,
           (SELECT COUNT(*)::int FROM boat_messages WHERE boat_id = b.id) AS message_count,
           (SELECT COUNT(*)::int FROM boat_hops    WHERE boat_id = b.id) AS hop_count,
           LEFT(
             (SELECT content FROM boat_messages WHERE boat_id = b.id
              ORDER BY created_at ASC LIMIT 1), 80
           ) AS initial_message
         FROM boats b
         JOIN users u ON u.id = b.creator_user_id
         WHERE ($1::text IS NULL OR b.status = $1)
         ORDER BY b.created_at DESC
         LIMIT $2 OFFSET $3`,
        [status, limit, offset],
      );

      const { rows: cnt } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM boats
         WHERE ($1::text IS NULL OR status = $1)`,
        [status],
      );

      return reply.send({ boats: rows, total: cnt[0].total, page, limit });
    },
  );

  // ── PATCH /admin/boats/:id ─────────────────────────────────────────────────
  app.patch<{ Params: { id: string }; Body: { status: string } }>(
    '/admin/boats/:id',
    async (req, reply) => {
      const { status } = req.body ?? {};
      if (!['active','paused','archived'].includes(status))
        return reply.code(400).send({ error: 'status inválido' });
      await pool.query('UPDATE boats SET status = $1 WHERE id = $2', [status, req.params.id]);
      return reply.send({ status: 'ok' });
    },
  );

  // ── DELETE /admin/boats/:id ────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/admin/boats/:id',
    async (req, reply) => {
      await pool.query('DELETE FROM boats WHERE id = $1', [req.params.id]);
      return reply.send({ status: 'ok' });
    },
  );

  // ── GET /admin/messages ────────────────────────────────────────────────────
  app.get<{ Querystring: { page?: string; limit?: string } }>(
    '/admin/messages',
    async (req, reply) => {
      const page   = Math.max(1, parseInt(req.query.page  ?? '1', 10));
      const limit  = Math.min(50, parseInt(req.query.limit ?? '20', 10));
      const offset = (page - 1) * limit;

      const { rows } = await pool.query(
        `SELECT
           bm.id, bm.content, bm.country_code, bm.created_at,
           b.id AS boat_id, b.stage,
           u.email AS author_email,
           (SELECT COUNT(*)::int FROM reports WHERE message_id = bm.id) AS report_count
         FROM boat_messages bm
         JOIN boats b ON b.id = bm.boat_id
         JOIN users u ON u.id = bm.user_id
         ORDER BY bm.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );

      const { rows: cnt } = await pool.query(
        'SELECT COUNT(*)::int AS total FROM boat_messages',
      );

      return reply.send({ messages: rows, total: cnt[0].total, page, limit });
    },
  );

  // ── DELETE /admin/messages/:id ─────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/admin/messages/:id',
    async (req, reply) => {
      await pool.query('DELETE FROM boat_messages WHERE id = $1', [req.params.id]);
      return reply.send({ status: 'ok' });
    },
  );

  // ── GET /admin/reports ─────────────────────────────────────────────────────
  app.get<{ Querystring: { page?: string; limit?: string } }>(
    '/admin/reports',
    async (req, reply) => {
      const page   = Math.max(1, parseInt(req.query.page  ?? '1', 10));
      const limit  = Math.min(50, parseInt(req.query.limit ?? '20', 10));
      const offset = (page - 1) * limit;

      const { rows } = await pool.query(
        `SELECT
           r.id, r.created_at,
           bm.id AS message_id, bm.content AS message_content, bm.country_code,
           ru.email AS reporter_email,
           mu.email AS author_email,
           b.id AS boat_id, b.stage
         FROM reports r
         JOIN boat_messages bm ON bm.id = r.message_id
         JOIN users ru ON ru.id = r.reporter_user_id
         JOIN users mu ON mu.id = bm.user_id
         JOIN boats b  ON b.id  = bm.boat_id
         ORDER BY r.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );

      const { rows: cnt } = await pool.query(
        'SELECT COUNT(*)::int AS total FROM reports',
      );

      return reply.send({ reports: rows, total: cnt[0].total, page, limit });
    },
  );

  // ── DELETE /admin/reports/:id  (descarta o report sem deletar a mensagem) ───
  app.delete<{ Params: { id: string } }>(
    '/admin/reports/:id',
    async (req, reply) => {
      await pool.query('DELETE FROM reports WHERE id = $1', [req.params.id]);
      return reply.send({ status: 'ok' });
    },
  );

  // ── GET /admin/settings ────────────────────────────────────────────────────
  app.get('/admin/settings', async (_req, reply) => {
    const { rows } = await pool.query(
      'SELECT key, value, label, updated_at FROM system_settings ORDER BY key',
    );
    return reply.send({ settings: rows });
  });

  // ── PATCH /admin/settings ──────────────────────────────────────────────────
  app.patch<{ Body: { key: string; value: string } }>(
    '/admin/settings',
    async (req, reply) => {
      const { key, value } = req.body ?? {};
      if (!key || value === undefined)
        return reply.code(400).send({ error: 'key e value são obrigatórios' });

      const { rows } = await pool.query(
        `UPDATE system_settings SET value = $1, updated_at = NOW()
         WHERE key = $2 RETURNING key, value, label, updated_at`,
        [value, key],
      );
      if (!rows.length) return reply.code(404).send({ error: 'configuração não encontrada' });
      return reply.send({ setting: rows[0] });
    },
  );
}
