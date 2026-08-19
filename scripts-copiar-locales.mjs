/**
 * Copia os dicionários para o `dist`.
 *
 * O `tsc` compila .ts e ignora .json — então sem este passo o servidor sobe
 * sem tradução nenhuma e cai calado no português, que é o pior tipo de falha:
 * a que parece funcionar. Roda no `npm run build`, junto do compilador.
 */
import { mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const de = join(process.cwd(), 'src', 'locales');
const para = join(process.cwd(), 'dist', 'locales');

if (!existsSync(de)) {
  console.log('[locales] src/locales nao existe — nada a copiar');
  process.exit(0);
}
mkdirSync(para, { recursive: true });
let n = 0;
for (const f of readdirSync(de)) {
  if (f.endsWith('.json')) { copyFileSync(join(de, f), join(para, f)); n++; }
}
console.log(`[locales] ${n} dicionario(s) copiado(s) para dist/locales`);
