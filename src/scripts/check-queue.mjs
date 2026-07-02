import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const { rows: users } = await pool.query(`
  SELECT
    u.email,
    u.id as user_id,
    u.created_at,
    COUNT(rq.id) FILTER (WHERE rq.status = 'pending')   as pending,
    COUNT(rq.id) FILTER (WHERE rq.status = 'delivered') as delivered,
    COUNT(rq.id) FILTER (WHERE rq.status = 'expired')   as expired
  FROM users u
  LEFT JOIN receiver_queue rq ON rq.user_id = u.id
  WHERE u.email NOT LIKE '%@adrift.bot'
  GROUP BY u.id, u.email, u.created_at
  ORDER BY u.created_at
`);

console.log('\n=== Usuários reais e fila ===');
console.table(users.map(r => ({ email: r.email, pending: r.pending, delivered: r.delivered, expired: r.expired })));

const { rows: queue } = await pool.query(`
  SELECT rq.status, rq.expires_at, b.id as boat_id, u.email
  FROM receiver_queue rq
  JOIN boats b ON b.id = rq.boat_id
  JOIN users u ON u.id = rq.user_id
  WHERE u.email NOT LIKE '%@adrift.bot'
  ORDER BY rq.queued_at DESC
`);

console.log('\n=== Entradas na fila (detalhado) ===');
console.table(queue.map(r => ({ email: r.email, status: r.status, expires: r.expires_at, boat: r.boat_id.slice(0,8) })));

await pool.end();
