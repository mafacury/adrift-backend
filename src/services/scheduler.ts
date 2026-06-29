import cron from 'node-cron';
import { pool } from '../db/pool.js';
import { routingQueue } from '../config/redis.js';
import { config } from '../config/index.js';

export function startScheduler() {
  // Every minute: expire timed-out queue entries and reroute those boats
  cron.schedule('* * * * *', async () => {
    try {
      const { rows } = await pool.query(
        `UPDATE receiver_queue
         SET status = 'expired'
         WHERE status = 'pending'
           AND expires_at <= NOW()
         RETURNING boat_id`,
      );

      for (const row of rows) {
        await routingQueue.add('route-boat', { boatId: row.boat_id, fromUserId: null });
      }

      if (rows.length > 0) {
        console.log(`[scheduler] expired ${rows.length} queue entries, re-routing`);
      }
    } catch (err) {
      console.error('[scheduler] queue-expiry error', err);
    }
  });

  // Daily at 02:00 UTC: archive boats idle for BOAT_IDLE_DAYS
  cron.schedule('0 2 * * *', async () => {
    try {
      const idleDays = config.boat.boatIdleDays;
      const { rows } = await pool.query(
        `UPDATE boats
         SET status = 'archived'
         WHERE status = 'active'
           AND last_hop_at < NOW() - ($1 || ' days')::INTERVAL
         RETURNING id, creator_user_id, unique_countries`,
        [idleDays],
      );

      for (const boat of rows) {
        console.log(
          `[scheduler] archived boat ${boat.id} (${boat.unique_countries} countries)`,
        );
        // TODO: send push notification to creator when FCM is wired up
      }
    } catch (err) {
      console.error('[scheduler] archival error', err);
    }
  });

  console.log('[scheduler] started');
}
