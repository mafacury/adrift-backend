import cron from 'node-cron';
import { pool } from '../db/pool.js';
import { processRouting, sweepStrandedBoats, reenfileirarNaoModerados } from './process.js';
import { botRespondSweep } from './bots.js';
import { journeySweep } from './journey.js';
import { reengageSweep } from './reengage.js';
import { avisarChegadas, avisarPrazo, avisarPerdas } from './alerts.js';
import { podarRastro } from './rastro.js';
import { manterVitrine } from './vitrine.js';

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

  // A cada minuto: a escada de avisos de barco. Antes disto o app avisava uma
  // vez só, na PARTIDA — que a 3000mn é horas antes de haver o que fazer — e
  // depois ficava mudo na chegada, no prazo correndo e na perda. Foi assim que
  // um barco se perdeu em 18/08 sem ninguém saber.
  cron.schedule('* * * * *', avisarChegadas);   // atracou
  cron.schedule('* * * * *', avisarPrazo);      // falta pouco (o que salva o barco)
  cron.schedule('* * * * *', avisarPerdas);     // partiu

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

  // A cada 30 min: empurra a chegada dos barcos da vitrine para a frente.
  // Sem isto a hora de chegada passa, o selo "segue viagem em ~4h17" some, e
  // quem entrou para dar uma olhada vê três barcos parados — que é o sintoma
  // de app quebrado, não de app bonito. Ver services/vitrine.ts.
  cron.schedule('*/30 * * * *', manterVitrine);

  // Uma vez por dia, às 04h UTC: poda o rastro de requisições.
  //
  // Uma tabela de log sem poda não é um sistema de log, é uma bomba-relógio:
  // ela só cresce, e ninguém repara até a conta do banco chegar. A hora é a
  // mais vazia do dia dos dois lados do Atlântico.
  cron.schedule('0 4 * * *', async () => {
    try {
      const n = await podarRastro();
      if (n > 0) console.log(`[rastro] podadas ${n} linhas com mais de 30 dias`);
    } catch (err) {
      console.error('[rastro] erro na poda', err);
    }
  });

  console.log('[scheduler] started (inline processing, no Redis)');
}
