/**
 * Fim da jornada — o barco volta para casa, atraca e vira quadro no museu.
 * Ver adrift-fim-da-jornada-plano.md.
 *
 * Todo assunto se esgota: depois de muitas mensagens o conteúdo desvia e vira
 * história sem fim. Em vez de deixar apodrecer, o barco é recolhido enquanto a
 * viagem ainda tem uma boa história para contar.
 *
 * Quatro finais, mesmo destino (arquivado), climas diferentes:
 *   chamado   — o dono pediu (a partir de MIN_COUNTRIES_TO_RETURN países)
 *   lendaria  — chegou ao estágio 8, deu a volta ao mundo
 *   esgotado  — MAX_IDLE_IGNORES pessoas SEGUIDAS deixaram passar
 *   perdido   — LOST_AT_SEA_DAYS sem nenhum porto (faxina, sem cerimônia)
 */
import { pool } from '../db/pool.js';
import { haversineKm } from './routing.js';

// A volta é uma travessia DIRETA, com vento a favor — por isso mais rápida
// que o vaguear porto a porto do routing.ts (20min + km/30, teto de 12h).
const RETURN_KM_PER_HOUR = 150;
const RETURN_MIN_HOURS   = 24;   // 1 dia — nem o porto vizinho chega na hora
const RETURN_MAX_HOURS   = 120;  // 5 dias — nem o outro lado do mundo demora mais
const KM_PER_NM          = 1.852;
const DEFAULT_KM         = 7000; // quando falta coordenada

/** Países visitados mínimos para o dono poder chamar o barco de volta. */
export const MIN_COUNTRIES_TO_RETURN = 5;
/** "Deixaram passar" SEGUIDOS que encerram a jornada (assunto esgotado). */
export const MAX_IDLE_IGNORES = 10;
/** Dias sem nenhum porto até o barco ser dado como perdido no mar. */
export const LOST_AT_SEA_DAYS = 90;

export type ArchiveReason =
  | 'chamado' | 'lendaria' | 'esgotado' | 'perdido' | 'moderado';

/** Texto do selo que fica no quadro do museu. */
export const REASON_LABEL: Record<ArchiveReason, string> = {
  chamado:  'Chamado de volta',
  lendaria: 'Nau Lendária',
  esgotado: 'Assunto esgotado',
  perdido:  'Perdido no mar',
  moderado: 'Recolhido pela moderação',
};

async function countryCoords(code: string | null) {
  if (!code) return null;
  const { rows } = await pool.query(
    `SELECT lat, lon FROM countries WHERE code = $1`, [code],
  );
  return rows[0]?.lat != null ? { lat: rows[0].lat, lon: rows[0].lon } : null;
}

/** Horas da travessia de volta, pela distância real até o país do dono. */
export async function returnHours(
  fromCountry: string | null,
  homeCountry: string | null,
): Promise<number> {
  const a = await countryCoords(fromCountry);
  const b = await countryCoords(homeCountry);
  const km = a && b ? haversineKm(a.lat, a.lon, b.lat, b.lon) : DEFAULT_KM;
  return Math.min(RETURN_MAX_HOURS, Math.max(RETURN_MIN_HOURS, km / RETURN_KM_PER_HOUR));
}

/** Onde o barco está agora (país do último pulo). */
async function currentCountry(boatId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT country_code FROM boat_hops
     WHERE boat_id = $1 ORDER BY hopped_at DESC LIMIT 1`,
    [boatId],
  );
  return rows[0]?.country_code ?? null;
}

/**
 * Milhas náuticas de toda a viagem: soma as distâncias entre portos
 * consecutivos. Congelada no arquivamento — o quadro não recalcula.
 */
export async function totalNauticalMiles(boatId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT c.lat, c.lon
     FROM boat_hops h
     JOIN countries c ON c.code = h.country_code
     WHERE h.boat_id = $1 AND c.lat IS NOT NULL
     ORDER BY h.hopped_at ASC`,
    [boatId],
  );
  let km = 0;
  for (let i = 1; i < rows.length; i++) {
    km += haversineKm(rows[i - 1].lat, rows[i - 1].lon, rows[i].lat, rows[i].lon);
  }
  return Math.round(km / KM_PER_NM);
}

/**
 * Começa a travessia de volta. O barco para de receber mensagens na hora,
 * mas se alguém estiver com ele em mãos a partida só acontece quando essa
 * pessoa responder ou a vez dela expirar — ninguém tem a mensagem arrancada.
 * Nesse caso arrives_home_at fica nulo e o sweep calcula na partida.
 */
export async function startReturn(
  boatId: string,
  reason: ArchiveReason,
): Promise<{ arrivesHomeAt: Date | null }> {
  const { rows: boatRows } = await pool.query(
    `SELECT b.id, u.country_code AS home
     FROM boats b JOIN users u ON u.id = b.creator_user_id
     WHERE b.id = $1`,
    [boatId],
  );
  if (!boatRows.length) return { arrivesHomeAt: null };
  const home = boatRows[0].home ?? null;

  const { rows: pending } = await pool.query(
    `SELECT 1 FROM receiver_queue WHERE boat_id = $1 AND status = 'pending' LIMIT 1`,
    [boatId],
  );

  let arrivesHomeAt: Date | null = null;
  if (!pending.length) {
    const hours = await returnHours(await currentCountry(boatId), home);
    arrivesHomeAt = new Date(Date.now() + hours * 3600_000);
  }

  await pool.query(
    `UPDATE boats
     SET status = 'returning', returning_at = NOW(),
         archive_reason = $2, home_country = $3, arrives_home_at = $4
     WHERE id = $1`,
    [boatId, reason, home, arrivesHomeAt],
  );
  console.log(`[journey] barco ${boatId} voltando para casa (${reason})`);
  return { arrivesHomeAt };
}

/** Atraca o barco: arquiva, congela as milhas e libera o baú para o dono. */
async function archiveBoat(boatId: string): Promise<void> {
  const nm = await totalNauticalMiles(boatId);
  await pool.query(
    `UPDATE boats
     SET status = 'archived', archived_at = NOW(), total_nm = $2,
         archive_reason = COALESCE(archive_reason, 'perdido')
     WHERE id = $1`,
    [boatId, nm],
  );
  console.log(`[journey] barco ${boatId} atracou em casa — ${nm} milhas náuticas`);
}

/**
 * Varredura do fim da jornada (roda a cada minuto pelo scheduler):
 *   1. barcos em volta que já chegaram   → arquiva
 *   2. barcos em volta que ficaram presos → calcula a partida agora que o
 *      porto atual se resolveu
 *   3. gatilhos automáticos              → começa a volta
 */
export async function journeySweep(): Promise<void> {
  try {
    // 1) chegadas
    const { rows: arrived } = await pool.query(
      `SELECT id FROM boats
       WHERE status = 'returning' AND arrives_home_at IS NOT NULL
         AND arrives_home_at <= NOW()`,
    );
    for (const b of arrived) await archiveBoat(b.id);

    // 2) partidas represadas: o porto atual já se resolveu, agora zarpa
    const { rows: waiting } = await pool.query(
      `SELECT b.id, b.home_country FROM boats b
       WHERE b.status = 'returning' AND b.arrives_home_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM receiver_queue rq
           WHERE rq.boat_id = b.id AND rq.status = 'pending'
         )`,
    );
    for (const b of waiting) {
      const hours = await returnHours(await currentCountry(b.id), b.home_country);
      await pool.query(
        `UPDATE boats SET arrives_home_at = NOW() + ($2 || ' hours')::INTERVAL
         WHERE id = $1`,
        [b.id, hours],
      );
      console.log(`[journey] barco ${b.id} zarpou de volta — ${Math.round(hours)}h`);
    }

    // 3) gatilhos automáticos
    const { rows: triggered } = await pool.query(
      `SELECT id,
         CASE
           WHEN stage >= 8                        THEN 'lendaria'
           WHEN idle_ignores >= $1                THEN 'esgotado'
           ELSE 'perdido'
         END AS reason
       FROM boats
       WHERE status = 'active'
         AND (stage >= 8
           OR idle_ignores >= $1
           OR last_hop_at < NOW() - ($2 || ' days')::INTERVAL)
       LIMIT 50`,
      [MAX_IDLE_IGNORES, LOST_AT_SEA_DAYS],
    );
    for (const b of triggered) await startReturn(b.id, b.reason as ArchiveReason);
  } catch (err) {
    console.error('[journey] sweep error', err);
  }
}
