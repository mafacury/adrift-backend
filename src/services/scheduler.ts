import cron from 'node-cron';
import { pool } from '../db/pool.js';
import { processRouting, sweepStrandedBoats, reenfileirarNaoModerados } from './process.js';
import { botRespondSweep } from './bots.js';
import { journeySweep } from './journey.js';
import { reengageSweep } from './reengage.js';

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
        await processRouting({ boatId: row.boat_id, fromUserId: null });
      }

      if (rows.length > 0) {
        console.log(`[scheduler] expired ${rows.length} queue entries, re-routing`);
      }
    } catch (err) {
      console.error('[scheduler] queue-expiry error', err);
    }
  });

  // Every minute: bots respond to boats waiting in their queues
  cron.schedule('* * * * *', botRespondSweep);

  // Every 15 min: re-route boats stranded without a pending queue entry
  cron.schedule('*/15 * * * *', sweepStrandedBoats);

  // A cada 15 min: barco parado SEM veredito nenhum — moderação que quebrou
  // (API fora, cota estourada) ou barco de seed criado direto no banco. O
  // sweep acima só solta o que foi aprovado, então sem isto eles ficariam
  // parados para sempre. Aqui eles são de fato julgados.
  cron.schedule('*/15 * * * *', reenfileirarNaoModerados);

  // A cada minuto: fim da jornada — chegadas em casa, partidas represadas e
  // os gatilhos automáticos (Nau Lendária, assunto esgotado, perdido no mar).
  // Substitui o antigo job diário que arquivava barcos parados sem cerimônia:
  // agora o barco faz a travessia de volta e vira quadro no museu.
  cron.schedule('* * * * *', journeySweep);

  // Uma vez por dia, às 15h UTC (fim de manhã no Brasil, tarde na Europa):
  // chama de volta quem sumiu. Não reserva barco — ver services/reengage.ts.
  cron.schedule('0 15 * * *', reengageSweep);

  console.log('[scheduler] started (inline processing, no Redis)');
}
