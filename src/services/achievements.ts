import { pool } from '../db/pool.js';
import { GIFTS, TIERS, tierOf } from './gifts.js';

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
  | 'gifts_given'      // presentes que ele deixou em barcos
  | 'max_countries';   // maior nº de países que um barco seu já visitou

/**
 * De quem é a conquista.
 *
 * As métricas se separam sozinhas: barcos lançados, recebidos, mensagens
 * escritas e presentes deixados dependem do que VOCÊ faz; países visitados
 * depende de estranhos que você nunca vai conhecer. São ritmos diferentes, e
 * misturados numa lista só a pessoa não entende por que um anda e o outro não.
 */
export type Scope = 'navegante' | 'frota';

export interface Achievement {
  id: string;
  title: string;
  description: string;
  tier: 'iniciante' | 'navegante' | 'explorador' | 'lenda';
  scope: Scope;
  icon: string;        // emoji placeholder (designer troca por ilustração)
  metric: Metric;
  target: number;
  /**
   * O presente que destrava. TODA conquista dá um — conquista vazia ensina
   * que conquista não vale a pena, e agora que presente tem estoque não há
   * motivo para nenhuma ficar sem.
   */
  gift: string;
}

// ── Catálogo (Temporada 1) ────────────────────────────────────────────────────
//
// A escada é longa de propósito, mas não aparece toda de uma vez: a tela só
// mostra as faixas já alcançadas mais a seguinte (ver visibilidade abaixo).
// O começo é curto porque alguém precisa conquistar algo nos primeiros dez
// minutos — sem isso a mecânica nem chega a se apresentar.
export const ACHIEVEMENTS: Achievement[] = [
  // ── Navegante: depende do que VOCÊ faz ──────────────────────────────────
  { id: 'first_boat',    title: 'Primeiro barco',        description: 'Lance seu primeiro barco ao mar.',          tier: 'iniciante',  scope: 'navegante', icon: '⛵', metric: 'boats_created',  target: 1,  gift: 'perola' },
  { id: 'messenger',     title: 'Mensageiro',            description: 'Receba um barco de outro navegante.',        tier: 'iniciante',  scope: 'navegante', icon: '⭐', metric: 'boats_received', target: 1,  gift: 'flor' },
  { id: 'first_reply',   title: 'Primeira resposta',     description: 'Escreva em um barco de outra pessoa.',       tier: 'iniciante',  scope: 'navegante', icon: '✍️', metric: 'messaged_boats', target: 1,  gift: 'concha' },
  { id: 'open_hand',     title: 'Mão aberta',            description: 'Deixe um presente em um barco.',             tier: 'iniciante',  scope: 'navegante', icon: '🎁', metric: 'gifts_given',    target: 1,  gift: 'garrafa' },

  { id: 'fleet',         title: 'Frota',                 description: 'Lance 5 barcos ao mar.',                     tier: 'navegante',  scope: 'navegante', icon: '⛵', metric: 'boats_created',  target: 5,  gift: 'no_marinheiro' },
  { id: 'sailor_heart',  title: 'Coração de marinheiro', description: 'Escreva em 5 barcos de outras pessoas.',     tier: 'navegante',  scope: 'navegante', icon: '❤️', metric: 'messaged_boats', target: 5,  gift: 'bracelete' },
  { id: 'busy_harbor',   title: 'Porto movimentado',     description: 'Receba 5 barcos.',                           tier: 'navegante',  scope: 'navegante', icon: '⚓', metric: 'boats_received', target: 5,  gift: 'moeda' },
  { id: 'generous',      title: 'Generoso',              description: 'Deixe 5 presentes em barcos.',               tier: 'navegante',  scope: 'navegante', icon: '🎁', metric: 'gifts_given',    target: 5,  gift: 'vela_cera' },

  { id: 'shipyard',      title: 'Estaleiro',             description: 'Lance 10 barcos ao mar.',                    tier: 'explorador', scope: 'navegante', icon: '🛠️', metric: 'boats_created',  target: 10, gift: 'mapa_velho' },
  { id: 'guardian',      title: 'Guardião dos mares',    description: 'Receba 25 barcos.',                          tier: 'explorador', scope: 'navegante', icon: '🛡️', metric: 'boats_received', target: 25, gift: 'escudo' },
  { id: 'world_voice',   title: 'Voz do mundo',          description: 'Escreva em 25 barcos de outras pessoas.',    tier: 'explorador', scope: 'navegante', icon: '📣', metric: 'messaged_boats', target: 25, gift: 'sino' },
  { id: 'benefactor',    title: 'Benfeitor',             description: 'Deixe 25 presentes em barcos.',              tier: 'explorador', scope: 'navegante', icon: '💝', metric: 'gifts_given',    target: 25, gift: 'timao' },

  { id: 'armada',        title: 'Armada',                description: 'Lance 20 barcos ao mar.',                    tier: 'lenda',      scope: 'navegante', icon: '⚓', metric: 'boats_created',  target: 20, gift: 'ancora_ouro' },
  { id: 'harbor_master', title: 'Mestre do porto',       description: 'Receba 100 barcos.',                         tier: 'lenda',      scope: 'navegante', icon: '🏛️', metric: 'boats_received', target: 100, gift: 'estrela' },

  // ── Frota: depende de onde os SEUS BARCOS chegam ────────────────────────
  { id: 'second_port',   title: 'Segundo porto',         description: 'Um barco seu chega a um segundo país.',      tier: 'iniciante',  scope: 'frota',     icon: '🧭', metric: 'max_countries',  target: 2,  gift: 'concha' },
  { id: 'traveler',      title: 'Viajante',              description: 'Um barco seu visita 3 países.',              tier: 'navegante',  scope: 'frota',     icon: '🌍', metric: 'max_countries',  target: 3,  gift: 'buzio' },
  { id: 'wanderer',      title: 'Andarilho',             description: 'Um barco seu visita 5 países.',              tier: 'navegante',  scope: 'frota',     icon: '🗺️', metric: 'max_countries',  target: 5,  gift: 'mapa_velho' },
  { id: 'explorer',      title: 'Explorador',            description: 'Um barco seu visita 10 países.',             tier: 'explorador', scope: 'frota',     icon: '🗺️', metric: 'max_countries',  target: 10, gift: 'coroa_prata' },
  { id: 'far_sight',     title: 'Vista longa',           description: 'Um barco seu visita 15 países.',             tier: 'explorador', scope: 'frota',     icon: '🔭', metric: 'max_countries',  target: 15, gift: 'catalejo' },
  { id: 'grand_explorer',title: 'Grande Explorador',     description: 'Um barco seu visita 25 países.',             tier: 'lenda',      scope: 'frota',     icon: '👑', metric: 'max_countries',  target: 25, gift: 'bussola' },
  { id: 'legend',        title: 'Lenda dos mares',       description: 'Um barco seu visita 50 países.',             tier: 'lenda',      scope: 'frota',     icon: '🏆', metric: 'max_countries',  target: 50, gift: 'coroa_ouro' },
];

/** Ordem das faixas — usada pela revelação progressiva. */
export const TIER_ORDER = ['iniciante', 'navegante', 'explorador', 'lenda'] as const;

// ── Cálculo das métricas do usuário (uma consulta) ────────────────────────────
async function computeMetrics(userId: string): Promise<Record<Metric, number>> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM boats WHERE creator_user_id = $1)                       AS boats_created,
       (SELECT COALESCE(MAX(unique_countries), 0) FROM boats WHERE creator_user_id = $1) AS max_countries,
       (SELECT COUNT(DISTINCT boat_id) FROM boat_hops WHERE to_user_id = $1)         AS boats_received,
       (SELECT COUNT(DISTINCT bm.boat_id)
          FROM boat_messages bm JOIN boats b ON b.id = bm.boat_id
         WHERE bm.user_id = $1 AND b.creator_user_id <> $1)                          AS messaged_boats,
       (SELECT COUNT(*) FROM boat_messages
         WHERE user_id = $1 AND gift_id IS NOT NULL)                                 AS gifts_given`,
    [userId],
  );
  const r = rows[0] ?? {};
  return {
    boats_created:  parseInt(r.boats_created  ?? '0', 10),
    boats_received: parseInt(r.boats_received ?? '0', 10),
    messaged_boats: parseInt(r.messaged_boats ?? '0', 10),
    gifts_given:    parseInt(r.gifts_given    ?? '0', 10),
    max_countries:  parseInt(r.max_countries  ?? '0', 10),
  };
}

export interface AchievementStatus {
  id: string; title: string; description: string;
  tier: string; scope: Scope; icon: string;
  target: number; current: number; earned: boolean;
  /**
   * O que esta conquista rende. Antes a rota não devolvia isto, e a pessoa via
   * "Frota: 3/5 barcos" sem a menor ideia de que aquilo destravava alguma
   * coisa — motivação jogada fora, o prêmio existia e estava escondido.
   */
  reward: { id: string; name: string; emoji: string; tier: string; rastro: string; quantidade: number | null } | null;
}

/**
 * Quais faixas a pessoa pode ver, por escopo.
 *
 * Mostrar as 21 de uma vez tem dois custos: assusta quem chega (a última pede
 * 50 países) e queima o jogo longo, porque não sobra nada para descobrir. A
 * regra é ver as faixas já alcançadas MAIS a seguinte — sempre há o que
 * perseguir, nunca a escada inteira.
 */
function faixasVisiveis(cumpridas: Set<string>, scope: Scope): Set<string> {
  const doEscopo = ACHIEVEMENTS.filter((a) => a.scope === scope);
  let maior = 0;
  doEscopo.forEach((a) => {
    if (!cumpridas.has(a.id)) return;
    const i = TIER_ORDER.indexOf(a.tier as any);
    if (i > maior) maior = i;
  });
  // a faixa alcançada + a próxima
  return new Set(TIER_ORDER.slice(0, maior + 2));
}

export async function getAchievementsForUser(userId: string): Promise<{
  achievements: AchievementStatus[];
  earnedCount: number;
  total: number;
  /** Quantas ficaram escondidas adiante — a tela mostra "mais N pela frente". */
  hidden: number;
}> {
  const m = await computeMetrics(userId);
  const cumpridas = new Set(
    ACHIEVEMENTS.filter((a) => m[a.metric] >= a.target).map((a) => a.id),
  );

  const visiveis = {
    navegante: faixasVisiveis(cumpridas, 'navegante'),
    frota:     faixasVisiveis(cumpridas, 'frota'),
  };

  const todas = ACHIEVEMENTS.map((a) => {
    const g = GIFTS[a.gift];
    const tier = g ? tierOf(g.weight) : null;
    const current = Math.min(m[a.metric], a.target);
    return {
      a,
      status: {
        id: a.id, title: a.title, description: a.description,
        tier: a.tier, scope: a.scope, icon: a.icon,
        target: a.target, current, earned: cumpridas.has(a.id),
        reward: g && tier ? {
          id: g.id, name: g.name, emoji: g.emoji,
          tier, rastro: TIERS[tier].rastro,
          quantidade: TIERS[tier].estoqueInicial,
        } : null,
      } as AchievementStatus,
    };
  });

  // cumprida sempre aparece, mesmo se a faixa dela já saiu de vista
  const mostrar = todas.filter(({ a, status }) =>
    status.earned || visiveis[a.scope].has(a.tier));

  return {
    achievements: mostrar.map((x) => x.status),
    earnedCount: cumpridas.size,
    total: ACHIEVEMENTS.length,
    hidden: todas.length - mostrar.length,
  };
}

/**
 * Conquistas cumpridas que ainda não foram comemoradas.
 *
 * O catálogo é calculado das métricas, então não existe "acabou de cumprir" —
 * o que existe é a diferença entre o que está cumprido e o que a pessoa já viu
 * (tabela achievements_seen, migração 017).
 *
 * Na PRIMEIRA vez que alguém chega aqui, tudo que já estava cumprido é
 * carimbado como visto e não devolve nada. Sem isso, quem já joga há semanas
 * levaria cinco comemorações na cara de uma vez — e a primeira coisa que a
 * comemoração precisa ser é rara.
 */
export async function pendingAchievements(userId: string): Promise<Achievement[]> {
  const m = await computeMetrics(userId);
  const earned = ACHIEVEMENTS.filter(a => m[a.metric] >= a.target);
  if (earned.length === 0) return [];

  const { rows: seen } = await pool.query(
    `SELECT achievement_id FROM achievements_seen WHERE user_id = $1`, [userId],
  );

  // primeira visita: assenta a régua no que já existe e não comemora nada
  if (seen.length === 0) {
    await markAchievementsSeen(userId, earned.map(a => a.id));
    return [];
  }

  const jaViu = new Set(seen.map(r => r.achievement_id));
  return earned.filter(a => !jaViu.has(a.id));
}

export async function markAchievementsSeen(userId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `INSERT INTO achievements_seen (user_id, achievement_id)
     SELECT $1, UNNEST($2::text[])
     ON CONFLICT DO NOTHING`,
    [userId, ids],
  );
}

/** IDs das conquistas já cumpridas — usado pelo Meu Baú (Etapa 2). */
export async function earnedAchievementIds(userId: string): Promise<string[]> {
  const m = await computeMetrics(userId);
  return ACHIEVEMENTS.filter((a) => m[a.metric] >= a.target).map((a) => a.id);
}
