import { Worker, Job } from 'bullmq';
import { config } from '../config/index.js';

const connection = { url: config.redisUrl };
import { pool } from '../db/pool.js';
import { routingQueue } from '../config/redis.js';
import {
  pickNextReceiver,
  enqueueForReceiver,
  getLastHopCountry,
} from '../services/routing.js';

export interface RoutingJobData {
  boatId: string;
  fromUserId: string | null;
}

async function processRouting(job: Job<RoutingJobData>) {
  const { boatId, fromUserId } = job.data;

  const lastCountry = await getLastHopCountry(boatId);
  const nextUserId = await pickNextReceiver(boatId, lastCountry);

  if (!nextUserId) {
    // No eligible receiver — boat stays in the ocean
    console.log(`[routing] boat ${boatId} has no eligible receiver — waiting in high seas`);
    // Re-queue after 30 min to retry
    await routingQueue.add(
      'route-boat',
      { boatId, fromUserId },
      { delay: 30 * 60 * 1000 },
    );
    return;
  }

  // Determine receiver's country (from their last hop or last known location)
  const { rows: locRows } = await pool.query(
    `SELECT country_code FROM boat_hops
     WHERE to_user_id = $1
     ORDER BY hopped_at DESC
     LIMIT 1`,
    [nextUserId],
  );
  // Fall back to 'XX' if we have no prior hop data
  const toCountryCode: string = locRows[0]?.country_code ?? 'XX';

  await enqueueForReceiver(boatId, nextUserId);

  console.log(`[routing] boat ${boatId} → user ${nextUserId} (${toCountryCode})`);

  // Note: recordHop is called when the receiver actually opens / interacts,
  // not at queue time, to accurately reflect where the boat "is".
  // We store the pending queue entry; the hop is recorded on delivery.
}

export function startRoutingWorker() {
  const worker = new Worker<RoutingJobData>(
    'routing-queue',
    processRouting,
    { connection, concurrency: 10 },
  );

  worker.on('failed', (job, err) => {
    console.error(`[routing] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
