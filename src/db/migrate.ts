import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Funciona tanto com "tsx src/db/migrate.ts" quanto com "node dist/db/migrate.js"
// pois ambos ficam dois níveis abaixo da raiz do projeto
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'src', 'db', 'migrations');

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const dir = MIGRATIONS_DIR;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const { rows } = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [file],
    );
    if (rows.length > 0) {
      console.log(`[migrate] skip ${file}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await pool.query('COMMIT');
      console.log(`[migrate] applied ${file}`);
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  }

  await pool.end();
}

migrate().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
