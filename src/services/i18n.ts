/**
 * Idiomas no servidor.
 *
 * O app traduz o que está na tela; aqui traduz-se o que SAI dele — e-mail,
 * push, a página pública da jornada. São textos que a pessoa recebe quando não
 * está com o app aberto, então o servidor precisa saber sozinho em que língua
 * falar com cada um. É para isso que existe `users.lang` (migração 028).
 *
 * Mesma regra do cliente: o TEXTO EM PORTUGUÊS É A CHAVE, e falta de tradução
 * cai no original em vez de mostrar chave crua. Ver mobile/services/i18n.ts,
 * onde a decisão está explicada por inteiro.
 *
 * Os JSON são os mesmos do app, gerados pelo mesmo CSV por
 * scripts/traducoes.mjs — uma fonte só para as duas pontas.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from '../db/pool.js';

const AQUI = dirname(fileURLToPath(import.meta.url));

/** `pt` não tem arquivo: é a língua de origem, o fallback já a devolve. */
const IDIOMAS = ['en', 'fr', 'es', 'ar', 'de', 'hi'];

function carregar(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const l of IDIOMAS) {
    // O `dist` espelha `src`, então os JSON ficam ao lado do módulo compilado.
    const p = join(AQUI, '..', 'locales', `${l}.json`);
    try {
      if (existsSync(p)) out[l] = JSON.parse(readFileSync(p, 'utf8'));
    } catch (err) {
      console.error(`[i18n] não consegui ler ${l}.json:`, err);
    }
  }
  return out;
}

const DICIONARIOS = carregar();

export function idiomaSuportado(codigo: string | null | undefined): string {
  const c = String(codigo ?? '').slice(0, 2).toLowerCase();
  return c === 'pt' || IDIOMAS.includes(c) ? c : 'pt';
}

/**
 * Traduz para um idioma explícito.
 *
 * Diferente do cliente, aqui não há "idioma atual": o servidor fala com muita
 * gente ao mesmo tempo, e guardar isso em variável de módulo seria um bug
 * esperando a segunda requisição simultânea.
 */
export function tr(
  lang: string, texto: string, vars?: Record<string, string | number>,
): string {
  const dic = DICIONARIOS[lang];
  let saida = (dic && dic[texto]) || texto;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      saida = saida.split(`{${k}}`).join(String(v));
    }
  }
  return saida;
}

/** O idioma de uma pessoa. Cai em português quando não se sabe. */
export async function idiomaDoUsuario(userId: string): Promise<string> {
  try {
    const { rows } = await pool.query('SELECT lang FROM users WHERE id = $1', [userId]);
    return idiomaSuportado(rows[0]?.lang);
  } catch {
    return 'pt';
  }
}

/** Nome de país, do próprio Node (mesma fonte que o app usa no cliente). */
export function nomeDoPais(lang: string, codigo: string): string {
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(codigo) ?? codigo;
  } catch {
    return codigo;
  }
}
