import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, emTransacao } from './pool.js';

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
    // A migração e o registro dela são o mesmo ato. Separados, o pior caso é
    // silencioso: o SQL aplica e o registro falha, então o próximo arranque
    // roda tudo de novo sobre um banco que já mudou. `pool.query('BEGIN')` não
    // agrupava de verdade — ver `emTransacao` em pool.ts.
    await emTransacao(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    });
    console.log(`[migrate] applied ${file}`);
  }

  await pool.end();
}

migrate().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
