/**
 * Agradecimentos por presente.
 *
 * É o único caminho de volta que existe no Adrift, e ele é FECHADO de
 * propósito: o remetente escolhe uma frase de uma lista, e o banco guarda a
 * chave dela. Nunca texto digitado.
 *
 * A regra do produto é essa e não tem exceção — se algum dia uma feature
 * parecer precisar de texto livre entre duas pessoas, ela está mal desenhada.
 * Sem texto livre não há moderação a fazer, não há assédio a filtrar e não há
 * como burlar os Termos de Uso por um canal lateral.
 *
 * O texto das frases NÃO mora aqui: mora no app, em constants/agradecimentos.ts.
 * O servidor só valida a chave. Assim, traduzir é mexer numa tabela do cliente,
 * e reescrever uma frase melhora todos os recados antigos de uma vez.
 */
import { pool } from '../db/pool.js';

/** As chaves aceitas. Mudou aqui, muda no app — os dois lados usam a mesma lista. */
export const FRASES = [
  'obrigado',
  'chegou_longe',
  'guardei',
  'mais_bonito',
  'gentileza',
  'fez_meu_dia',
] as const;

export type FraseKey = typeof FRASES[number];

export function fraseValida(k: unknown): k is FraseKey {
  return typeof k === 'string' && (FRASES as readonly string[]).includes(k);
}

export interface Recado {
  id: string;
  phraseKey: string;
  createdAt: string;
  seen: boolean;
  /** O presente que está sendo agradecido. */
  giftId: string;
  /** O barco em que ele foi deixado — quem deu já sabe qual é. */
  boatCode: string;
}

/**
 * Registra o obrigado.
 *
 * Só o DONO do barco pode agradecer, só uma vez por presente, e nunca a si
 * mesmo. As três condições estão na consulta, não no app: quem chama a API
 * direto passa pelas mesmas regras.
 */
export async function agradecer(
  userId: string, messageId: string, phrase: FraseKey,
): Promise<'ok' | 'nao_encontrado' | 'repetido'> {
  const { rows } = await pool.query(
    `SELECT bm.user_id AS autor
       FROM boat_messages bm
       JOIN boats b ON b.id = bm.boat_id
      WHERE bm.id = $1
        AND bm.gift_id IS NOT NULL
        AND b.creator_user_id = $2
        AND bm.user_id <> $2`,
    [messageId, userId],
  );
  if (!rows.length) return 'nao_encontrado';

  const { rowCount } = await pool.query(
    `INSERT INTO gift_thanks (message_id, from_user_id, to_user_id, phrase_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (message_id, from_user_id) DO NOTHING`,
    [messageId, userId, rows[0].autor, phrase],
  );
  return rowCount ? 'ok' : 'repetido';
}

/** A caixa de recados de quem RECEBEU agradecimentos. */
export async function recadosDe(userId: string): Promise<{ recados: Recado[]; naoLidos: number }> {
  const { rows } = await pool.query(
    `SELECT t.id, t.phrase_key, t.created_at, t.seen_at,
            bm.gift_id, LEFT(bm.boat_id::text, 5) AS boat_code
       FROM gift_thanks t
       JOIN boat_messages bm ON bm.id = t.message_id
      WHERE t.to_user_id = $1
      ORDER BY t.created_at DESC
      LIMIT 60`,
    [userId],
  );
  return {
    recados: rows.map((r) => ({
      id: r.id,
      phraseKey: r.phrase_key,
      createdAt: r.created_at,
      seen: !!r.seen_at,
      giftId: r.gift_id,
      boatCode: r.boat_code,
    })),
    naoLidos: rows.filter((r) => !r.seen_at).length,
  };
}

export async function marcarRecadosLidos(userId: string): Promise<void> {
  await pool.query(
    `UPDATE gift_thanks SET seen_at = NOW()
      WHERE to_user_id = $1 AND seen_at IS NULL`,
    [userId],
  );
}

/** Quais presentes desta lista o usuário JÁ agradeceu (para o botão não repetir). */
export async function jaAgradecidos(userId: string, messageIds: string[]): Promise<Set<string>> {
  if (!messageIds.length) return new Set();
  const { rows } = await pool.query(
    `SELECT message_id FROM gift_thanks
      WHERE from_user_id = $1 AND message_id = ANY($2::uuid[])`,
    [userId, messageIds],
  );
  return new Set(rows.map((r) => r.message_id));
}
