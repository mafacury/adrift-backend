import { pool } from '../db/pool.js';

/**
 * Conquistas — sistema data-driven.
 * Adicionar uma conquista (ou uma temporada nova) = acrescentar uma entrada
 * neste catálogo. O estado ("cumprida") é CALCULADO dos dados que já existem
 * (barcos, países, mensagens), então é retroativo por natureza — nada de
 * migração ou de "começar do zero".
 *
 * A cada conquista corresponde uma métrica + um alvo. As métricas são
 * calculadas uma vez por usuário e reaproveitadas por todas as conquistas.
 */

export type Metric =
  | 'boats_created'    // barcos que o usuário lançou
  | 'boats_received'   // barcos distintos que chegaram até ele (foi uma parada)
  | 'messaged_boats'   // barcos de OUTROS em que ele escreveu
  | 'max_countries';   // maior nº de países que um barco seu já visitou

export interface Achievement {
  id: string;
  title: string;
  description: string;
  tier: 'iniciante' | 'navegante' | 'explorador' | 'lenda';
  icon: string;        // emoji placeholder (designer troca por ilustração)
  metric: Metric;
  target: number;
  gift?: string;       // presente que destrava (usado a partir da Etapa 2)
}

// ── Catálogo (Temporada 1) ────────────────────────────────────────────────────
export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_boat',    title: 'Primeiro barco',        description: 'Lance seu primeiro barco ao mar.',        tier: 'iniciante',  icon: '⛵', metric: 'boats_created',  target: 1,  gift: 'perola' },
  { id: 'messenger',     title: 'Mensageiro',            description: 'Receba um barco de outro navegante.',      tier: 'iniciante',  icon: '⭐', metric: 'boats_received', target: 1,  gift: 'flor' },

  { id: 'fleet',         title: 'Frota',                 description: 'Lance 5 barcos ao mar.',                    tier: 'navegante',  icon: '⛵', metric: 'boats_created',  target: 5 },
  { id: 'sailor_heart',  title: 'Coração de marinheiro', description: 'Escreva em 5 barcos de outras pessoas.',    tier: 'navegante',  icon: '❤️', metric: 'messaged_boats', target: 5,  gift: 'bracelete' },
  { id: 'traveler',      title: 'Viajante',              description: 'Um barco seu visita 3 países.',             tier: 'navegante',  icon: '🌍', metric: 'max_countries',  target: 3,  gift: 'buzio' },

  { id: 'explorer',      title: 'Explorador',            description: 'Um barco seu visita 10 países.',            tier: 'explorador', icon: '🗺️', metric: 'max_countries',  target: 10, gift: 'coroa_prata' },
  { id: 'guardian',      title: 'Guardião dos mares',    description: 'Receba 25 barcos.',                         tier: 'explorador', icon: '🛡️', metric: 'boats_received', target: 25 },
  { id: 'world_voice',   title: 'Voz do mundo',          description: 'Escreva em 25 barcos de outras pessoas.',   tier: 'explorador', icon: '📣', metric: 'messaged_boats', target: 25 },

  { id: 'grand_explorer',title: 'Grande Explorador',     description: 'Um barco seu visita 25 países.',            tier: 'lenda',      icon: '👑', metric: 'max_countries',  target: 25 },
  { id: 'armada',        title: 'Armada',                description: 'Lance 20 barcos ao mar.',                   tier: 'lenda',      icon: '⚓', metric: 'boats_created',  target: 20 },
  { id: 'legend',        title: 'Lenda dos mares',       description: 'Um barco seu visita 50 países.',            tier: 'lenda',      icon: '🏆', metric: 'max_countries',  target: 50, gift: 'coroa_ouro' },
];

// ── Cálculo das métricas do usuário (uma consulta) ────────────────────────────
async function computeMetrics(userId: string): Promise<Record<Metric, number>> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM boats WHERE creator_user_id = $1)                       AS boats_created,
       (SELECT COALESCE(MAX(unique_countries), 0) FROM boats WHERE creator_user_id = $1) AS max_countries,
       (SELECT COUNT(DISTINCT boat_id) FROM boat_hops WHERE to_user_id = $1)         AS boats_received,
       (SELECT COUNT(DISTINCT bm.boat_id)
          FROM boat_messages bm JOIN boats b ON b.id = bm.boat_id
         WHERE bm.user_id = $1 AND b.creator_user_id <> $1)                          AS messaged_boats`,
    [userId],
  );
  const r = rows[0] ?? {};
  return {
    boats_created:  parseInt(r.boats_created  ?? '0', 10),
    boats_received: parseInt(r.boats_received ?? '0', 10),
    messaged_boats: parseInt(r.messaged_boats ?? '0', 10),
    max_countries:  parseInt(r.max_countries  ?? '0', 10),
  };
}

export interface AchievementStatus {
  id: string; title: string; description: string;
  tier: string; icon: string;
  target: number; current: number; earned: boolean;
}

export async function getAchievementsForUser(userId: string): Promise<{
  achievements: AchievementStatus[];
  earnedCount: number;
  total: number;
}> {
  const m = await computeMetrics(userId);
  const achievements = ACHIEVEMENTS.map((a) => {
    const current = Math.min(m[a.metric], a.target);
    return {
      id: a.id, title: a.title, description: a.description,
      tier: a.tier, icon: a.icon,
      target: a.target, current, earned: m[a.metric] >= a.target,
    };
  });
  return {
    achievements,
    earnedCount: achievements.filter((a) => a.earned).length,
    total: achievements.length,
  };
}

/** IDs das conquistas já cumpridas — usado pelo Meu Baú (Etapa 2). */
export async function earnedAchievementIds(userId: string): Promise<string[]> {
  const m = await computeMetrics(userId);
  return ACHIEVEMENTS.filter((a) => m[a.metric] >= a.target).map((a) => a.id);
}
