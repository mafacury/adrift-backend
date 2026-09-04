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
const IDIOMAS = ['en', 'fr', 'es', 'ar', 'de', 'hi', 'ja'];

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

/**
 * O idioma pedido, se o servidor o fala. Senão, depende de QUAL "senão":
 *
 *   nada (nulo, vazio)  → português. É a coluna `lang` das pessoas que já
 *                         existiam antes da migração 028, e ela é nula porque
 *                         ninguém sabia — mas essas pessoas são as primeiras do
 *                         app, brasileiras, e já vinham recebendo tudo em
 *                         português. Mudá-las para inglês seria trocar a língua
 *                         de gente real por causa de um dado ausente.
 *   código que não falamos (uk, ru, it…) → INGLÊS.
 *
 * Essa segunda linha é a correção de 04/09/2026. Antes, ucraniano caía em
 * português: o mesmo bug que apareceu na tela do app (ver o comentário em
 * mobile/services/i18n.ts) e que aqui saía por e-mail e por push, onde é ainda
 * pior — a pessoa recebe e não tem nem como trocar o idioma.
 */
export function idiomaSuportado(codigo: string | null | undefined): string {
  const c = String(codigo ?? '').slice(0, 2).toLowerCase();
  if (c === 'pt' || IDIOMAS.includes(c)) return c;
  return c === '' ? 'pt' : 'en';
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

/** O idioma de uma pessoa. A regra do "não sei" mora em `idiomaSuportado`. */
export async function idiomaDoUsuario(userId: string): Promise<string> {
  try {
    const { rows } = await pool.query('SELECT lang FROM users WHERE id = $1', [userId]);
    return idiomaSuportado(rows[0]?.lang);
  } catch {
    // Banco fora do ar é o mesmo estado de coluna nula: não se sabe. Passar
    // pela mesma função evita duas regras para a mesma pergunta.
    return idiomaSuportado(null);
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
