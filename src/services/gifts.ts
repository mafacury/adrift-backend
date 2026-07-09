import { pool } from '../db/pool.js';
import { ACHIEVEMENTS, earnedAchievementIds } from './achievements.js';

/**
 * Presentes (baús) — sistema data-driven, tudo CALCULADO (sem tabela nova).
 * O "Meu Baú" de um usuário = boas-vindas + presentes da região dele +
 * presentes das conquistas que ele já cumpriu. Nada gasta, nada se perde.
 *
 * Os emojis são PLACEHOLDERS — o designer troca por ilustrações depois.
 */

export type GiftSource = 'welcome' | 'region' | 'achievement';

export interface Gift {
  id: string;
  name: string;
  emoji: string;        // placeholder até a arte chegar
  source: GiftSource;
}

// ── Catálogo de presentes ─────────────────────────────────────────────────────
export const GIFTS: Record<string, Gift> = {
  // Boas-vindas (todos ganham ao se cadastrar)
  amuleto:      { id: 'amuleto',      name: 'Amuleto da sorte',     emoji: '🍀', source: 'welcome' },
  lanterna:     { id: 'lanterna',     name: 'Lanterna do porto',    emoji: '🏮', source: 'welcome' },

  // De conquista
  perola:       { id: 'perola',       name: 'Pérola',               emoji: '🫧', source: 'achievement' },
  flor:         { id: 'flor',         name: 'Flor',                 emoji: '🌷', source: 'achievement' },
  no_marinheiro:{ id: 'no_marinheiro',name: 'Nó de marinheiro',     emoji: '🪢', source: 'achievement' },
  bracelete:    { id: 'bracelete',    name: 'Bracelete',            emoji: '📿', source: 'achievement' },
  buzio:        { id: 'buzio',        name: 'Búzio',                emoji: '🐚', source: 'achievement' },
  coroa_prata:  { id: 'coroa_prata',  name: 'Coroa de prata',       emoji: '🥈', source: 'achievement' },
  escudo:       { id: 'escudo',       name: 'Escudo do guardião',   emoji: '🛡️', source: 'achievement' },
  sino:         { id: 'sino',         name: 'Sino do mundo',        emoji: '🔔', source: 'achievement' },
  bussola:      { id: 'bussola',      name: 'Bússola antiga',       emoji: '🧭', source: 'achievement' },
  ancora_ouro:  { id: 'ancora_ouro',  name: 'Âncora de ouro',       emoji: '⚓', source: 'achievement' },
  coroa_ouro:   { id: 'coroa_ouro',   name: 'Coroa de ouro',        emoji: '🥇', source: 'achievement' },

  // Regionais (por país)
  pandeiro:     { id: 'pandeiro',     name: 'Pandeiro',             emoji: '🥁', source: 'region' },
  abacaxi:      { id: 'abacaxi',      name: 'Abacaxi',              emoji: '🍍', source: 'region' },
  liberdade:    { id: 'liberdade',    name: 'Estátua da Liberdade', emoji: '🗽', source: 'region' },
  sakura:       { id: 'sakura',       name: 'Flor de cerejeira',    emoji: '🌸', source: 'region' },
  sushi:        { id: 'sushi',        name: 'Sushi',                emoji: '🍣', source: 'region' },
  flamenco:     { id: 'flamenco',     name: 'Flamenco',             emoji: '💃', source: 'region' },
  paella:       { id: 'paella',       name: 'Paella',               emoji: '🥘', source: 'region' },
  croissant:    { id: 'croissant',    name: 'Croissant',            emoji: '🥐', source: 'region' },
  torre_eiffel: { id: 'torre_eiffel', name: 'Torre Eiffel',         emoji: '🗼', source: 'region' },
  pretzel:      { id: 'pretzel',      name: 'Pretzel',              emoji: '🥨', source: 'region' },
  tambor:       { id: 'tambor',       name: 'Tambor',               emoji: '🪘', source: 'region' },
  lotus:        { id: 'lotus',        name: 'Lótus',                emoji: '🪷', source: 'region' },
  canguru:      { id: 'canguru',      name: 'Canguru',              emoji: '🦘', source: 'region' },
  bordo:        { id: 'bordo',        name: 'Folha de bordo',       emoji: '🍁', source: 'region' },
  lampiao:      { id: 'lampiao',      name: 'Lampião coreano',      emoji: '🏮', source: 'region' },
  taco:         { id: 'taco',         name: 'Taco',                 emoji: '🌮', source: 'region' },
  mundo:        { id: 'mundo',        name: 'Lembrança do mundo',   emoji: '🌍', source: 'region' },
};

const WELCOME_GIFTS = ['amuleto', 'lanterna'];

// Presentes por país (2 letras). Países sem entrada recebem 'mundo'.
const REGION_GIFTS: Record<string, string[]> = {
  BR: ['pandeiro', 'abacaxi'],
  US: ['liberdade'],
  JP: ['sakura', 'sushi'],
  ES: ['flamenco', 'paella'],
  FR: ['croissant', 'torre_eiffel'],
  DE: ['pretzel'],
  NG: ['tambor'],
  IN: ['lotus'],
  AU: ['canguru'],
  CA: ['bordo'],
  KR: ['lampiao'],
  MX: ['taco'],
};

// ── Meu Baú de um usuário (calculado) ─────────────────────────────────────────
export async function getGiftsForUser(userId: string): Promise<{
  gifts: (Gift & { unlocked: boolean; via?: string })[];
  unlockedCount: number;
}> {
  // país do usuário
  const { rows } = await pool.query(
    `SELECT country_code FROM users WHERE id = $1`,
    [userId],
  );
  const country: string = rows[0]?.country_code ?? 'XX';

  // conquistas cumpridas → presentes destravados
  const earnedIds = new Set(await earnedAchievementIds(userId));
  const giftFromAchievement = new Set(
    ACHIEVEMENTS.filter((a) => a.gift && earnedIds.has(a.id)).map((a) => a.gift as string),
  );

  const regionIds = REGION_GIFTS[country] ?? ['mundo'];
  const regionSet = new Set(regionIds);
  const welcomeSet = new Set(WELCOME_GIFTS);

  // Monta a lista completa marcando o que está destravado
  const list: (Gift & { unlocked: boolean; via?: string })[] = [];

  // 1) boas-vindas (sempre destravados)
  for (const id of WELCOME_GIFTS) {
    list.push({ ...GIFTS[id], unlocked: true, via: 'Boas-vindas' });
  }
  // 2) região do usuário (sempre destravados)
  for (const id of regionIds) {
    if (GIFTS[id]) list.push({ ...GIFTS[id], unlocked: true, via: 'Da sua terra' });
  }
  // 3) presentes de conquista — mostra todos, destravando os cumpridos
  for (const a of ACHIEVEMENTS) {
    if (!a.gift) continue;
    const g = GIFTS[a.gift];
    if (!g) continue;
    list.push({ ...g, unlocked: giftFromAchievement.has(a.gift), via: a.title });
  }

  return {
    gifts: list,
    unlockedCount: list.filter((g) => g.unlocked).length,
  };
}

/** Verifica se o usuário pode dar um presente (para a Etapa 3). */
export async function userOwnsGift(userId: string, giftId: string): Promise<boolean> {
  const { gifts } = await getGiftsForUser(userId);
  return gifts.some((g) => g.id === giftId && g.unlocked);
}
