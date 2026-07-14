import { pool } from '../db/pool.js';
import { config } from '../config/index.js';
import { STAGE_CASE_SQL } from './progress.js';

// ── Fluxo dos barcos ───────────────────────────────────────────────────────
// Viagem com distância REAL: tempo = base + km/velocidade (±20% de "maré").
// Humanos têm prioridade (com proteções anti-enchente); bots são o oceano de
// reserva que mantém tudo em movimento — a mesma regra serve para 3 usuários
// ou 30 mil.
const TRAVEL_BASE_MIN   = 20;    // minutos mínimos de qualquer travessia
const TRAVEL_KM_PER_MIN = 30;    // "velocidade" do barco
const TRAVEL_MAX_MIN    = 720;   // teto: meio dia até o outro lado do mundo
const DEFAULT_KM        = 7000;  // distância padrão quando falta coordenada
const ARRIVAL_GAP_MIN   = 45;    // espaçamento mínimo entre chegadas p/ humano
const MAX_PENDING_HUMAN = 2;     // teto de barcos aguardando por humano

export interface Receiver { id: string; isBot: boolean; country: string | null }

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Minutos de viagem entre dois países (coordenadas na tabela countries). */
export async function travelMinutes(
  fromCountry: string | null,
  toCountry: string | null,
): Promise<number> {
  let km = DEFAULT_KM;
  if (fromCountry && toCountry) {
    const { rows } = await pool.query(
      `SELECT code, lat, lon FROM countries WHERE code IN ($1, $2)`,
      [fromCountry, toCountry],
    );
    const a = rows.find(r => r.code === fromCountry);
    const b = rows.find(r => r.code === toCountry);
    if (a?.lat != null && b?.lat != null) {
      km = haversineKm(a.lat, a.lon, b.lat, b.lon);
    }
  }
  const jitter = 0.8 + Math.random() * 0.4; // ±20% de maré
  return Math.min(TRAVEL_MAX_MIN, Math.round((TRAVEL_BASE_MIN + km / TRAVEL_KM_PER_MIN) * jitter));
}

/** País de destino para um bot: ativo e ainda não visitado (senão, qualquer ativo). */
export async function pickRandomDestCountry(boatId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT code FROM countries
     WHERE active
       AND code NOT IN (SELECT country_code FROM boat_countries WHERE boat_id = $1)
     ORDER BY RANDOM() LIMIT 1`,
    [boatId],
  );
  if (rows[0]) return rows[0].code;
  const { rows: any_ } = await pool.query(
    `SELECT code FROM countries WHERE active ORDER BY RANDOM() LIMIT 1`,
  );
  return any_[0]?.code ?? null;
}

export async function pickNextReceiver(boatId: string): Promise<Receiver | null> {
  const { maxIgnoresPerUser } = config.boat;

  // FASE 1 — humanos elegíveis, priorizando quem está há mais tempo sem
  // receber (anti-seca), com espaçamento entre chegadas e teto de fila
  // (anti-enchente).
  const { rows: humans } = await pool.query(
    `SELECT u.id, u.country_code
     FROM users u
     WHERE u.ban_status = 'active'
       AND u.receiving_paused = FALSE
       AND u.oauth_provider IS DISTINCT FROM 'bot'
       AND u.last_active_at >= NOW() - INTERVAL '7 days'
       AND u.reputation_score > 0
       -- nunca viu este barco / não é o criador
       AND u.id NOT IN (SELECT to_user_id FROM boat_hops WHERE boat_id = $1)
       AND u.id != (SELECT creator_user_id FROM boats WHERE id = $1)
       -- não ignorou este barco além do limite
       AND (SELECT COALESCE(SUM(count), 0) FROM boat_ignore_counts
            WHERE boat_id = $1 AND user_id = u.id) < $2
       -- quem deixou ESTE barco expirar não o recebe de novo
       AND u.id NOT IN (SELECT user_id FROM receiver_queue
                        WHERE boat_id = $1 AND status = 'expired')
       -- teto de fila (anti-enchente)
       AND (SELECT COUNT(*) FROM receiver_queue rq2
            WHERE rq2.user_id = u.id AND rq2.status = 'pending') < ${MAX_PENDING_HUMAN}
       -- espaçamento mínimo entre chegadas
       AND NOT EXISTS (
         SELECT 1 FROM receiver_queue rqg
         WHERE rqg.user_id = u.id
           AND rqg.arrives_at > NOW() - INTERVAL '${ARRIVAL_GAP_MIN} minutes'
       )
     ORDER BY
       (SELECT COALESCE(MAX(arrives_at), TIMESTAMPTZ 'epoch')
        FROM receiver_queue WHERE user_id = u.id) ASC,
       RANDOM()
     LIMIT 1`,
    [boatId, maxIgnoresPerUser],
  );
  if (humans[0]) {
    return { id: humans[0].id, isBot: false, country: humans[0].country_code ?? null };
  }

  // FASE 2 — oceano de reserva: um bot qualquer (bots podem repetir barcos;
  // são apenas os "portos" que carimbam países aleatórios)
  const { rows: bots } = await pool.query(
    `SELECT id FROM users
     WHERE oauth_provider = 'bot' AND ban_status = 'active'
     ORDER BY RANDOM() LIMIT 1`,
  );
  return bots[0] ? { id: bots[0].id, isBot: true, country: null } : null;
}

export async function enqueueForReceiver(
  boatId: string,
  userId: string,
  opts: { travelMin: number; destCountry: string | null },
): Promise<void> {
  // o barco "navega" travelMin minutos (distância real) antes de atracar;
  // o prazo de resposta só começa a contar quando ele chega (arrives_at)
  const arrivesAt = new Date(Date.now() + opts.travelMin * 60_000);
  const expiresAt = new Date(arrivesAt.getTime() + config.boat.queueTimeoutMinutes * 60 * 1000);
  await pool.query(
    `INSERT INTO receiver_queue (boat_id, user_id, arrives_at, expires_at, dest_country)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [boatId, userId, arrivesAt, expiresAt, opts.destCountry],
  );
}

export async function getLastHopCountry(boatId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT country_code FROM boat_hops
     WHERE boat_id = $1
     ORDER BY hopped_at DESC
     LIMIT 1`,
    [boatId],
  );
  if (rows[0]) return rows[0].country_code;
  // sem pulos ainda: o barco parte do país de lançamento (mensagem inicial)
  const { rows: first } = await pool.query(
    `SELECT country_code FROM boat_messages
     WHERE boat_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [boatId],
  );
  return first[0]?.country_code ?? null;
}

export async function recordHop(params: {
  boatId: string;
  fromUserId: string | null;
  toUserId: string;
  countryCode: string;
  messageId: string | null;
}): Promise<void> {
  const { boatId, fromUserId, toUserId, countryCode, messageId } = params;

  await pool.query('BEGIN');
  try {
    // Record the hop
    await pool.query(
      `INSERT INTO boat_hops (boat_id, from_user_id, to_user_id, country_code, message_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [boatId, fromUserId, toUserId, countryCode, messageId],
    );

    // Deduplicated country tracking
    await pool.query(
      `INSERT INTO boat_countries (boat_id, country_code)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [boatId, countryCode],
    );

    // Unique interaction per country
    if (messageId) {
      await pool.query(
        `INSERT INTO boat_country_interactions (boat_id, country_code, user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [boatId, countryCode, toUserId],
      );
    }

    // Update boat stage + last_hop_at + unique_countries
    await pool.query(
      `UPDATE boats
       SET
         unique_countries = (
           SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1
         ),
         stage = ${STAGE_CASE_SQL},
         last_hop_at = NOW()
       WHERE id = $1`,
      [boatId],
    );

    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK');
    throw err;
  }
}
