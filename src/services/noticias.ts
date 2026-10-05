import { pool } from '../db/pool.js';
import { ajuste } from './ajustes.js';
import { placarDeConvites } from './indicacao.js';

/**
 * As notícias do avião — o que a faixa do aviãozinho da Jornada anuncia.
 *
 * Pedido do dono em 05/10/2026: a Jornada parecia parada entre um barco e
 * outro, e ele quis um avião de publicidade cruzando o céu com novidades do
 * app. A regra que vale aqui é a mesma do horizonte: NADA É INVENTADO. Cada
 * faixa sai de uma linha do banco — um barco que zarpou de verdade, um marco
 * que foi batido de verdade, um total que é a soma de verdade. Quando não há
 * novidade, o avião anuncia um total; quando o total é pequeno demais para
 * impressionar (barcos lançados, hoje uns 20), ele simplesmente não sai.
 *
 * O servidor manda DADOS, não frases: tipo + código + país + número. A frase é
 * montada no app, pelo `t()`, no idioma de quem olha — e o nome do país sai do
 * próprio navegador, já traduzido.
 *
 * PRIVACIDADE: sai o código do barco (os 5 últimos caracteres, o mesmo do
 * Ranking) e o país do porto — nunca id, nunca e-mail, nunca de quem é. O país
 * do porto é o de quem acabou de receber o barco; ele já aparece no cartão de
 * mensagens de qualquer próximo receptor, e no ranking o barco já vem com a
 * bandeira de casa. Bot e gente saem iguais: não há como saber qual foi qual.
 */

export type Noticia =
  | { id: string; tipo: 'zarpou';   codigo: string; stage: number; pais: string }
  | { id: string; tipo: 'mensagem'; codigo: string; stage: number }
  | { id: string; tipo: 'lancado';  pais: string }
  | { id: string; tipo: 'marco';    codigo: string; stage: number; n: number }
  | { id: string; tipo: 'meu';      codigo: string; pais: string }
  | { id: string; tipo: 'total_mensagens' | 'mensagens_24h' | 'milhas' | 'paises' | 'barcos'; n: number }
  | { id: string; tipo: 'indicacao' };

/** Quanto tempo vale "acaba de": passou disso, a notícia envelheceu. */
const RECENTE_MIN = 60;
/** O próprio barco tem prazo maior — a pessoa quer saber mesmo que tenha sido há pouco. */
const MEU_HORAS = 3;
/** Marcos de países. O último é a volta ao mundo inteiro. */
const MARCOS = [10, 25, 50, 75, 100, 125, 150, 175, 195];
/**
 * Abaixo disso o total de barcos não vira faixa. "Já somos 21 barcos" anuncia
 * que o app está vazio — o contrário do que o avião existe para dizer.
 */
const MIN_BARCOS = 50;
/** Modelo a partir do qual "recebeu mais uma mensagem" é notícia (Bravia, 6). */
const STAGE_DE_PRESTIGIO = 6;

const CACHE_MS = 60_000;

/** O barco é público: sai o código, e o criador só serve para separar "o seu". */
interface Interna { noticia: Noticia; dono?: string }

let cache: { at: number; itens: Interna[] } | null = null;

const codigo = (id: string) => id.slice(-5).toUpperCase();

// Barco que pode aparecer: ativo, de verdade (nem vitrine nem bot), de conta
// que não foi banida.
const BARCO_VALIDO = `
  b.status = 'active' AND b.archived_at IS NULL AND b.vitrine IS NOT TRUE
  AND cu.email NOT LIKE '%@adrift.bot'
  AND COALESCE(cu.ban_status, 'active') <> 'banned' AND cu.deleted_at IS NULL`;

async function compartilhadas(): Promise<Interna[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.itens;
  const itens: Interna[] = [];

  // 1. Barcos que acabaram de passar por um porto — o último de cada um.
  const { rows: pulos } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (h.boat_id)
              h.boat_id, h.country_code, h.message_id, h.hopped_at,
              b.stage, b.creator_user_id
         FROM boat_hops h
         JOIN boats b  ON b.id  = h.boat_id
         JOIN users cu ON cu.id = b.creator_user_id
        WHERE h.hopped_at > NOW() - make_interval(mins => $1)
          AND h.country_code IS NOT NULL AND h.country_code <> 'XX'
          AND ${BARCO_VALIDO}
        ORDER BY h.boat_id, h.hopped_at DESC
     ) x ORDER BY hopped_at DESC LIMIT 12`,
    [RECENTE_MIN],
  );
  for (const p of pulos) {
    const stage = Number(p.stage) || 1;
    // modelo grande que ganhou mensagem é notícia por si; o resto é partida
    const n: Noticia = p.message_id && stage >= STAGE_DE_PRESTIGIO
      ? { id: `mensagem:${p.boat_id}:${p.message_id}`, tipo: 'mensagem', codigo: codigo(p.boat_id), stage }
      : { id: `zarpou:${p.boat_id}:${p.country_code}`, tipo: 'zarpou', codigo: codigo(p.boat_id), stage, pais: p.country_code };
    itens.push({ noticia: n, dono: p.creator_user_id });
  }

  // 2. Barcos novos no mar (24 h). O país é o de casa, ou o da 1ª mensagem.
  const { rows: novos } = await pool.query(
    `SELECT b.id, b.creator_user_id,
            COALESCE(b.home_country,
              (SELECT m.country_code FROM boat_messages m
                WHERE m.boat_id = b.id ORDER BY m.created_at LIMIT 1)) AS pais
       FROM boats b JOIN users cu ON cu.id = b.creator_user_id
      WHERE b.created_at > NOW() - INTERVAL '24 hours' AND ${BARCO_VALIDO}
      ORDER BY b.created_at DESC LIMIT 5`,
  );
  for (const b of novos) {
    if (!b.pais || b.pais === 'XX') continue;
    itens.push({ noticia: { id: `lancado:${b.id}`, tipo: 'lancado', pais: b.pais }, dono: b.creator_user_id });
  }

  // 3. Marcos de países batidos nas últimas 24 h: o N-ésimo país distinto do
  //    barco tem a data em que foi tocado pela primeira vez.
  const { rows: marcos } = await pool.query(
    `SELECT boat_id, n, stage, creator_user_id FROM (
       SELECT bc.boat_id, bc.first_seen_at, b.stage, b.creator_user_id,
              ROW_NUMBER() OVER (PARTITION BY bc.boat_id ORDER BY bc.first_seen_at) AS n
         FROM boat_countries bc
         JOIN boats b  ON b.id  = bc.boat_id
         JOIN users cu ON cu.id = b.creator_user_id
        WHERE ${BARCO_VALIDO}
          AND bc.boat_id IN (SELECT boat_id FROM boat_countries
                              WHERE first_seen_at > NOW() - INTERVAL '24 hours')
     ) x
     WHERE first_seen_at > NOW() - INTERVAL '24 hours' AND n = ANY($1::int[])
     ORDER BY first_seen_at DESC LIMIT 5`,
    [MARCOS],
  );
  for (const m of marcos) {
    itens.push({
      noticia: { id: `marco:${m.boat_id}:${m.n}`, tipo: 'marco', codigo: codigo(m.boat_id), stage: Number(m.stage) || 1, n: Number(m.n) },
      dono: m.creator_user_id,
    });
  }

  // 4. Os totais — a faixa de reserva, que sempre tem o que dizer.
  const { rows: [tot] } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM boat_messages)::int                                   AS mensagens,
       (SELECT COUNT(*) FROM boat_messages
         WHERE created_at > NOW() - INTERVAL '24 hours')::int                      AS mensagens_24h,
       (SELECT COUNT(DISTINCT country_code) FROM boat_countries)::int              AS paises,
       (SELECT COALESCE(ROUND(SUM(total_nm)), 0) FROM boats
         WHERE vitrine IS NOT TRUE)::bigint                                        AS milhas,
       (SELECT COUNT(*) FROM boats b JOIN users cu ON cu.id = b.creator_user_id
         WHERE b.vitrine IS NOT TRUE AND cu.email NOT LIKE '%@adrift.bot'
           AND COALESCE(b.archive_reason, '') <> 'teste')::int                     AS barcos`,
  );
  if (tot.mensagens >= 100)     itens.push({ noticia: { id: 'total_mensagens', tipo: 'total_mensagens', n: tot.mensagens } });
  if (tot.mensagens_24h >= 20)  itens.push({ noticia: { id: 'mensagens_24h',   tipo: 'mensagens_24h',   n: tot.mensagens_24h } });
  if (tot.paises >= 20)         itens.push({ noticia: { id: 'paises',          tipo: 'paises',          n: tot.paises } });
  if (Number(tot.milhas) >= 10_000) itens.push({ noticia: { id: 'milhas',      tipo: 'milhas',          n: Number(tot.milhas) } });
  if (tot.barcos >= MIN_BARCOS) itens.push({ noticia: { id: 'barcos',          tipo: 'barcos',          n: tot.barcos } });

  cache = { at: Date.now(), itens };
  return itens;
}

export interface Noticiario {
  /** Intervalo entre dois voos, em segundos — giráveis no painel. */
  intervalo: { min: number; max: number };
  noticias: Noticia[];
}

/**
 * O noticiário que esta pessoa vê. O comum (em cache) menos os barcos dela,
 * que entram como "seu barco" — e o convite, enquanto ela ainda não ganhou o
 * presente de indicação.
 */
export async function noticiasPara(userId: string): Promise<Noticiario> {
  const min = await ajuste('aviao_intervalo_min_s', 45);
  const max = Math.max(await ajuste('aviao_intervalo_max_s', 120), min);

  const comuns = (await compartilhadas())
    .filter((i) => i.dono !== userId)
    .map((i) => i.noticia);

  const { rows: meus } = await pool.query(
    `SELECT DISTINCT ON (h.boat_id) h.boat_id, h.country_code
       FROM boat_hops h JOIN boats b ON b.id = h.boat_id
      WHERE b.creator_user_id = $1 AND b.status = 'active'
        AND h.hopped_at > NOW() - make_interval(hours => $2)
        AND h.country_code IS NOT NULL AND h.country_code <> 'XX'
      ORDER BY h.boat_id, h.hopped_at DESC`,
    [userId, MEU_HORAS],
  );
  const proprias: Noticia[] = meus.map((m) => ({
    id: `meu:${m.boat_id}:${m.country_code}`, tipo: 'meu', codigo: codigo(m.boat_id), pais: m.country_code,
  }));

  try {
    if ((await placarDeConvites(userId)).premiados === 0) {
      proprias.push({ id: 'indicacao', tipo: 'indicacao' });
    }
  } catch { /* sem placar, sem convite — o resto do noticiário segue */ }

  return { intervalo: { min, max }, noticias: [...proprias, ...comuns] };
}
