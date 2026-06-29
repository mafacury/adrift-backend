import { pool } from '../db/pool.js';
import { config } from '../config/index.js';

export async function pickNextReceiver(
  boatId: string,
  lastCountryCode: string | null,
): Promise<string | null> {
  const { maxIgnoresPerUser } = config.boat;

  // Find eligible receivers — prefer different country, fall back to any
  const query = `
    WITH candidates AS (
      SELECT u.id, u.fcm_token,
             -- prefer different country from last hop
             CASE WHEN u.id NOT IN (
               SELECT to_user_id FROM boat_hops
               WHERE boat_id = $1 AND country_code = $2
             ) THEN 0 ELSE 1 END AS same_country_penalty
      FROM users u
      WHERE
        u.ban_status = 'active'
        AND u.last_active_at >= NOW() - INTERVAL '7 days'
        -- never seen this boat
        AND u.id NOT IN (
          SELECT to_user_id FROM boat_hops WHERE boat_id = $1
        )
        -- ignore limit not reached
        AND (
          SELECT COALESCE(SUM(count), 0)
          FROM boat_ignore_counts
          WHERE boat_id = $1 AND user_id = u.id
        ) < $3
        -- no active moderation penalty
        AND u.reputation_score > 0
    )
    SELECT id
    FROM candidates
    ORDER BY same_country_penalty ASC, RANDOM()
    LIMIT 1
  `;

  const { rows } = await pool.query(query, [boatId, lastCountryCode ?? '', maxIgnoresPerUser]);
  return rows[0]?.id ?? null;
}

export async function enqueueForReceiver(boatId: string, userId: string): Promise<void> {
  const expiresAt = new Date(Date.now() + config.boat.queueTimeoutMinutes * 60 * 1000);
  await pool.query(
    `INSERT INTO receiver_queue (boat_id, user_id, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [boatId, userId, expiresAt],
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
  return rows[0]?.country_code ?? null;
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
         stage = CASE
           WHEN (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 50 THEN 6
           WHEN (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 35 THEN 5
           WHEN (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 20 THEN 4
           WHEN (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 10 THEN 3
           WHEN (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 4  THEN 2
           ELSE 1
         END,
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
