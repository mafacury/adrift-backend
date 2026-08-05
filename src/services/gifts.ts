import { pool } from '../db/pool.js';
import { ACHIEVEMENTS, earnedAchievementIds } from './achievements.js';

/**
 * Presentes (baús) — sistema data-driven, tudo CALCULADO (sem tabela nova).
 * Fontes: boas-vindas (todos) + conquistas (destravadas). Regionais descartados.
 *
 * Cada presente tem um PESO (valor/raridade): garrafa≈1 ... joia≈1000. O peso
 * ordena o baú e mantém a recompensa proporcional ao esforço. No futuro, com o
 * admin, as conquistas terão faixas de peso e liberarão a faixa inteira.
 *
 * Os emojis são PLACEHOLDERS — o designer troca por ilustrações depois.
 */

export type GiftSource = 'welcome' | 'achievement';

export interface Gift {
  id: string;
  name: string;
  emoji: string;        // placeholder até a arte chegar
  weight: number;       // valor / raridade
  source: GiftSource;
}

/**
 * Os niveis do bau.
 *
 * O `weight` existia desde o comeco mas so servia para ORDENAR a lista — era um
 * numero que ninguem via e que nao fazia nada. Agora ele vira nivel, e o nivel
 * responde a unica pergunta que importa: o que este presente deixa para tras?
 *
 * Nao e forca, nao e bonus. E alcance do rastro. Um presente comum fica no
 * porto onde voce o deixou; um lendario viaja com o barco ate o fim e marca o
 * mapa de quem o lancou, para sempre. E por isso que alguem quereria um melhor:
 * nao para ganhar, para durar na historia de um estranho.
 */
export type Tier = 'comum' | 'incomum' | 'raro' | 'lendario';

export interface TierInfo {
  id: Tier;
  nome: string;
  /** O que o presente faz — a frase que aparece no bau. */
  rastro: string;
  /** Quantos vem ao destravar. `null` = infinito. */
  estoqueInicial: number | null;
}

export const TIERS: Record<Tier, TierInfo> = {
  comum:    { id: 'comum',    nome: 'Comum',    estoqueInicial: null, rastro: 'Fica no porto, junto da sua mensagem.' },
  incomum:  { id: 'incomum',  nome: 'Incomum',  estoqueInicial: 5,    rastro: 'Segue com o barco ate o proximo porto.' },
  raro:     { id: 'raro',     nome: 'Raro',     estoqueInicial: 3,    rastro: 'Viaja com o barco ate o fim da jornada.' },
  lendario: { id: 'lendario', nome: 'Lendario', estoqueInicial: 1,    rastro: 'Marca o mapa do barco para sempre.' },
};

/** O nivel sai do peso: um numero so, sem segunda fonte de verdade. */
export function tierOf(weight: number): Tier {
  if (weight <= 10)  return 'comum';
  if (weight <= 150) return 'incomum';
  if (weight <= 500) return 'raro';
  return 'lendario';
}


// ── Catálogo de presentes ─────────────────────────────────────────────────────
export const GIFTS: Record<string, Gift> = {
  // Boas-vindas (todos ganham ao se cadastrar) — comuns, peso baixo
  amuleto:       { id: 'amuleto',       name: 'Amuleto da sorte',   emoji: '🍀', weight: 5,    source: 'welcome' },
  lanterna:      { id: 'lanterna',      name: 'Lanterna do porto',  emoji: '🏮', weight: 8,    source: 'welcome' },

  // De conquista — peso cresce com a dificuldade
  flor:          { id: 'flor',          name: 'Flor',               emoji: '🌷', weight: 40,   source: 'achievement' },
  perola:        { id: 'perola',        name: 'Pérola',             emoji: '🫧', weight: 50,   source: 'achievement' },
  buzio:         { id: 'buzio',         name: 'Búzio',              emoji: '🐚', weight: 100,  source: 'achievement' },
  no_marinheiro: { id: 'no_marinheiro', name: 'Nó de marinheiro',   emoji: '🪢', weight: 120,  source: 'achievement' },
  bracelete:     { id: 'bracelete',     name: 'Bracelete',          emoji: '📿', weight: 150,  source: 'achievement' },
  escudo:        { id: 'escudo',        name: 'Escudo do guardião', emoji: '🛡️', weight: 300,  source: 'achievement' },
  sino:          { id: 'sino',          name: 'Sino do mundo',      emoji: '🔔', weight: 320,  source: 'achievement' },
  coroa_prata:   { id: 'coroa_prata',   name: 'Coroa de prata',     emoji: '🥈', weight: 350,  source: 'achievement' },
  bussola:       { id: 'bussola',       name: 'Bússola antiga',     emoji: '🧭', weight: 600,  source: 'achievement' },
  ancora_ouro:   { id: 'ancora_ouro',   name: 'Âncora de ouro',     emoji: '⚓', weight: 650,  source: 'achievement' },
  coroa_ouro:    { id: 'coroa_ouro',    name: 'Coroa de ouro',      emoji: '🥇', weight: 1000, source: 'achievement' },
};

const WELCOME_GIFTS = ['amuleto', 'lanterna'];


/**
 * Entrega o estoque inicial de uma origem, uma vez so.
 *
 * As conquistas sao CALCULADAS a partir das metricas, entao "ja cumprida" e
 * verdade para sempre — sem o registro em gift_grants, cada abertura do bau
 * entregaria os mesmos presentes de novo e o estoque seria infinito na pratica.
 */
async function concederUmaVez(userId: string, chave: string, giftId: string, qtd: number) {
  const { rowCount } = await pool.query(
    `INSERT INTO gift_grants (user_id, source_key) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [userId, chave],
  );
  if (!rowCount) return;  // ja foi entregue antes

  await pool.query(
    `INSERT INTO gift_inventory (user_id, gift_id, quantity) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, gift_id)
     DO UPDATE SET quantity = gift_inventory.quantity + $3, updated_at = NOW()`,
    [userId, giftId, qtd],
  );
}

/** Tira um do bau. Presentes infinitos (boas-vindas) nao gastam nada. */
export async function consumeGift(userId: string, giftId: string): Promise<void> {
  const g = GIFTS[giftId];
  if (!g || TIERS[tierOf(g.weight)].estoqueInicial === null) return;
  await pool.query(
    `UPDATE gift_inventory SET quantity = quantity - 1, updated_at = NOW()
      WHERE user_id = $1 AND gift_id = $2 AND quantity > 0`,
    [userId, giftId],
  );
}

/** Usado pela loja mais adiante: um pacote comprado entra por aqui. */
export async function grantGift(userId: string, giftId: string, qtd: number, chave: string) {
  await concederUmaVez(userId, chave, giftId, qtd);
}

export interface ItemDoBau extends Gift {
  unlocked: boolean;
  via: string;
  tier: Tier;
  /** O que este nivel deixa para tras. */
  rastro: string;
  /** `null` quando e infinito (boas-vindas). */
  quantity: number | null;
  infinito: boolean;
}

// ── Meu Baú de um usuário (calculado) ─────────────────────────────────────────
export async function getGiftsForUser(userId: string): Promise<{
  gifts: ItemDoBau[];
  unlockedCount: number;
}> {
  const earnedIds = new Set(await earnedAchievementIds(userId));

  // entrega o estoque inicial das conquistas cumpridas (uma vez cada)
  for (const a of ACHIEVEMENTS) {
    if (!a.gift || !earnedIds.has(a.id)) continue;
    const g = GIFTS[a.gift];
    if (!g) continue;
    const inicial = TIERS[tierOf(g.weight)].estoqueInicial;
    if (inicial !== null) await concederUmaVez(userId, `achv:${a.id}`, a.gift, inicial);
  }

  const { rows } = await pool.query(
    `SELECT gift_id, quantity FROM gift_inventory WHERE user_id = $1`, [userId],
  );
  const estoque = new Map<string, number>(rows.map((r: any) => [r.gift_id, Number(r.quantity)]));

  const giftUnlocked = new Set(
    ACHIEVEMENTS.filter((a) => a.gift && earnedIds.has(a.id)).map((a) => a.gift as string),
  );

  const monta = (g: Gift, unlocked: boolean, via: string): ItemDoBau => {
    const tier = tierOf(g.weight);
    const infinito = TIERS[tier].estoqueInicial === null;
    return {
      ...g, unlocked, via, tier,
      rastro: TIERS[tier].rastro,
      infinito,
      quantity: infinito ? null : (estoque.get(g.id) ?? 0),
    };
  };

  const list: ItemDoBau[] = [];
  // 1) boas-vindas: destravados e INFINITOS de proposito — ninguem pode ficar
  //    sem ter o que retribuir, senao o app deixa de ser generoso quando o
  //    estoque acaba, e a generosidade e o produto
  for (const id of WELCOME_GIFTS) {
    if (GIFTS[id]) list.push(monta(GIFTS[id], true, 'Boas-vindas'));
  }
  // 2) presentes de conquista — mostra todos, destravando os cumpridos
  for (const a of ACHIEVEMENTS) {
    if (!a.gift) continue;
    const g = GIFTS[a.gift];
    if (!g) continue;
    list.push(monta(g, giftUnlocked.has(a.gift), a.title));
  }

  list.sort((x, y) => x.weight - y.weight);
  return { gifts: list, unlockedCount: list.filter((g) => g.unlocked).length };
}

/** Info leve de um presente pelo id (para exibir junto da mensagem). */
export function giftInfo(id: string | null): { id: string; name: string; emoji: string } | null {
  if (!id || !GIFTS[id]) return null;
  const g = GIFTS[id];
  return { id: g.id, name: g.name, emoji: g.emoji };
}

/** O usuário pode dar este presente? (está destravado no baú dele) */
export async function userOwnsGift(userId: string, giftId: string): Promise<boolean> {
  const { gifts } = await getGiftsForUser(userId);
  const g = gifts.find((x) => x.id === giftId);
  if (!g || !g.unlocked) return false;
  // duas condicoes agora: o DIREITO (conquista) e o ESTOQUE (que acaba)
  return g.infinito || (g.quantity ?? 0) > 0;
}

