import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Bots devem criar barcos, mas NUNCA receber (last_active_at > 7 dias atrás)
const { rowCount } = await pool.query(`
  UPDATE users
  SET last_active_at = '2020-01-01'::timestamptz
  WHERE email LIKE '%@adrift.bot'
`);
console.log(`✅  ${rowCount} bots marcados como inativos (nunca receberão barcos via roteamento)`);

// Verificar o estado
const { rows } = await pool.query(`
  SELECT email, last_active_at FROM users WHERE email LIKE '%@adrift.bot' ORDER BY email
`);
console.table(rows.map(r => ({ email: r.email, last_active_at: r.last_active_at })));

await pool.end();
