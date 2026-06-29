import { Worker, Job } from 'bullmq';
import { pool } from '../db/pool.js';
import { moderate } from '../services/moderation.js';
import { routingQueue } from '../config/redis.js';
import { config } from '../config/index.js';

const connection = { url: config.redisUrl };

export interface ModerationJobData {
  boatId: string;
  messageId: string | null;  // null when receptor sent boat without message
  content: string;
  userId: string;
  countryCode: string;
}

async function processModeration(job: Job<ModerationJobData>) {
  const { boatId, messageId, content, userId } = job.data;

  // Fetch boat message history for context
  const { rows: historyRows } = await pool.query(
    `SELECT bm.country_code, bm.content
     FROM boat_messages bm
     WHERE bm.boat_id = $1
     ORDER BY bm.created_at ASC`,
    [boatId],
  );

  // Check if this is a new user
  const { rows: userRows } = await pool.query(
    `SELECT COUNT(*) AS sent
     FROM boat_hops
     WHERE from_user_id = $1`,
    [userId],
  );
  const boatsSent = parseInt(userRows[0]?.sent ?? '0', 10);
  const isNewUser = boatsSent < config.moderation.newUserBoatThreshold;

  const { verdict, layer, detail } = await moderate(content, historyRows, isNewUser);

  // Log the moderation result
  await pool.query(
    `INSERT INTO moderation_log (boat_id, message_id, verdict, layer, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [boatId, messageId, verdict, layer, detail],
  );

  if (verdict === 'approved') {
    // Hand off to routing queue
    await routingQueue.add('route-boat', { boatId, fromUserId: userId });
    console.log(`[moderation] boat ${boatId} approved → routing`);
  } else if (verdict === 'rejected') {
    // Silently discard — update boat status to archived
    await pool.query(`UPDATE boats SET status = 'archived' WHERE id = $1`, [boatId]);
    console.log(`[moderation] boat ${boatId} rejected (layer ${layer}): ${detail}`);
  } else {
    // uncertain → manual review queue (post-MVP placeholder)
    await pool.query(`UPDATE boats SET status = 'paused' WHERE id = $1`, [boatId]);
    console.log(`[moderation] boat ${boatId} uncertain → paused for review`);
  }
}

export function startModerationWorker() {
  const worker = new Worker<ModerationJobData>(
    'moderation-queue',
    processModeration,
    { connection, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    console.error(`[moderation] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
