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

// ── Meu Baú de um usuário (calculado) ─────────────────────────────────────────
export async function getGiftsForUser(userId: string): Promise<{
  gifts: (Gift & { unlocked: boolean; via?: string })[];
  unlockedCount: number;
}> {
  // conquistas cumpridas → presentes destravados
  const earnedIds = new Set(await earnedAchievementIds(userId));
  const giftUnlocked = new Set(
    ACHIEVEMENTS.filter((a) => a.gift && earnedIds.has(a.id)).map((a) => a.gift as string),
  );

  const list: (Gift & { unlocked: boolean; via?: string })[] = [];

  // 1) boas-vindas (sempre destravados)
  for (const id of WELCOME_GIFTS) {
    if (GIFTS[id]) list.push({ ...GIFTS[id], unlocked: true, via: 'Boas-vindas' });
  }
  // 2) presentes de conquista — mostra todos, destravando os cumpridos
  for (const a of ACHIEVEMENTS) {
    if (!a.gift) continue;
    const g = GIFTS[a.gift];
    if (!g) continue;
    list.push({ ...g, unlocked: giftUnlocked.has(a.gift), via: a.title });
  }

  // ordena por peso (do mais comum ao mais precioso)
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
  return gifts.some((g) => g.id === giftId && g.unlocked);
}
