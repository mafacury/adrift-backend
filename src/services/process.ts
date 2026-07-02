import { pool } from '../db/pool.js';
import { moderate } from './moderation.js';
import { config } from '../config/index.js';
import {
  pickNextReceiver,
  enqueueForReceiver,
  getLastHopCountry,
} from './routing.js';

/**
 * Processamento inline de moderação e roteamento.
 * Substitui as filas BullMQ/Redis — nesta escala, chamadas diretas são
 * mais simples e não exigem infraestrutura extra no Railway.
 * As funções são fire-and-forget: quem chama usa `void processX(...)`.
 */

export interface ModerationData {
  boatId: string;
  messageId: string | null;
  content: string;
  userId: string;
  countryCode: string;
}

export async function processModeration(data: ModerationData): Promise<void> {
  const { boatId, messageId, content, userId } = data;
  try {
    // Histórico do barco para contexto da IA
    const { rows: historyRows } = await pool.query(
      `SELECT bm.country_code, bm.content
       FROM boat_messages bm
       WHERE bm.boat_id = $1
       ORDER BY bm.created_at ASC`,
      [boatId],
    );

    // Usuário novo → limiar mais rígido
    const { rows: userRows } = await pool.query(
      `SELECT COUNT(*) AS sent FROM boat_hops WHERE from_user_id = $1`,
      [userId],
    );
    const boatsSent = parseInt(userRows[0]?.sent ?? '0', 10);
    const isNewUser = boatsSent < config.moderation.newUserBoatThreshold;

    const { verdict, layer, detail } = await moderate(content, historyRows, isNewUser);

    await pool.query(
      `INSERT INTO moderation_log (boat_id, message_id, verdict, layer, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [boatId, messageId, verdict, layer, detail],
    );

    if (verdict === 'approved') {
      console.log(`[moderation] boat ${boatId} approved → routing`);
      await processRouting({ boatId, fromUserId: userId });
    } else if (verdict === 'rejected') {
      await pool.query(`UPDATE boats SET status = 'archived' WHERE id = $1`, [boatId]);
      console.log(`[moderation] boat ${boatId} rejected (layer ${layer}): ${detail}`);
    } else {
      await pool.query(`UPDATE boats SET status = 'paused' WHERE id = $1`, [boatId]);
      console.log(`[moderation] boat ${boatId} uncertain → paused for review`);
    }
  } catch (err) {
    console.error(`[moderation] boat ${boatId} failed:`, err);
  }
}

export interface RoutingData {
  boatId: string;
  fromUserId: string | null;
}

export async function processRouting(data: RoutingData): Promise<void> {
  const { boatId } = data;
  try {
    const lastCountry = await getLastHopCountry(boatId);
    const nextUserId = await pickNextReceiver(boatId, lastCountry);

    if (!nextUserId) {
      // Sem receptor elegível agora — o sweep do scheduler tenta de novo depois
      console.log(`[routing] boat ${boatId} has no eligible receiver — waiting in high seas`);
      return;
    }

    await enqueueForReceiver(boatId, nextUserId);
    console.log(`[routing] boat ${boatId} → user ${nextUserId}`);
  } catch (err) {
    console.error(`[routing] boat ${boatId} failed:`, err);
  }
}

/**
 * Varredura: encontra barcos ativos e aprovados que não estão na fila de
 * ninguém (ex.: roteamento falhou, servidor reiniciou, sem receptor na hora)
 * e tenta roteá-los novamente. Chamada periodicamente pelo scheduler.
 */
export async function sweepStrandedBoats(): Promise<void> {
  try {
    const { rows } = await pool.query(
      `SELECT b.id
       FROM boats b
       WHERE b.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM receiver_queue rq
           WHERE rq.boat_id = b.id AND rq.status = 'pending'
         )
         -- só barcos já moderados e aprovados (ou sem log = seeds/demo, já na fila)
         AND NOT EXISTS (
           SELECT 1 FROM moderation_log ml
           WHERE ml.boat_id = b.id AND ml.verdict IN ('rejected', 'uncertain')
         )
       LIMIT 50`,
    );
    if (rows.length > 0) {
      console.log(`[sweep] re-routing ${rows.length} stranded boat(s)`);
      for (const row of rows) {
        await processRouting({ boatId: row.id, fromUserId: null });
      }
    }
  } catch (err) {
    console.error('[sweep] error', err);
  }
}
