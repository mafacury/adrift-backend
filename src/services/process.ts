import { pool } from '../db/pool.js';
import { moderate } from './moderation.js';
import { avaliarConduta } from './enforcement.js';
import { config } from '../config/index.js';
import { boatComingMessage } from './push.js';
import { avisar } from './notify.js';
import {
  pickNextReceiver,
  pickRandomDestCountry,
  enqueueForReceiver,
  getLastHopCountry,
  travelMinutes,
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
      `INSERT INTO moderation_log (boat_id, message_id, verdict, layer, detail, user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [boatId, messageId, verdict, layer, detail, userId],
    );

    if (verdict === 'approved') {
      console.log(`[moderation] boat ${boatId} approved → routing`);
      await processRouting({ boatId, fromUserId: userId });
    } else if (verdict === 'rejected') {
      await pool.query(
        `UPDATE boats SET status = 'archived', archived_at = NOW(),
                          archive_reason = 'moderado'
         WHERE id = $1`,
        [boatId],
      );
      console.log(`[moderation] boat ${boatId} rejected (layer ${layer}): ${detail}`);
      // Uma rejeição é acidente; cinco em 24h é ofício. Quem conta é o enforcement.
      await avaliarConduta(userId);
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
    // Barco voltando para casa (ou arquivado/pausado) não segue adiante —
    // a fila dele pode expirar durante a volta e cairia aqui.
    const { rows: st } = await pool.query(
      `SELECT status, vitrine FROM boats WHERE id = $1`, [boatId],
    );
    if (st[0]?.status !== 'active') return;

    // Barco de vitrine nunca entra na fila de uma pessoa de verdade. A trava
    // mora AQUI e não em cada varredura porque esta função é o funil único:
    // nenhum barco chega a um porto sem passar por ela. Assim a proteção vale
    // também para o caminho que alguém escrever amanhã sem saber que a coluna
    // `vitrine` existe. Ver services/vitrine.ts.
    if (st[0].vitrine) return;

    const lastCountry = await getLastHopCountry(boatId);
    const receiver = await pickNextReceiver(boatId);

    if (!receiver) {
      // Sem receptor elegível agora — o sweep do scheduler tenta de novo depois
      console.log(`[routing] boat ${boatId} has no eligible receiver — waiting in high seas`);
      return;
    }

    // Destino: bot = país aleatório ativo (sorteado JÁ na partida);
    // humano = o país dele. A viagem dura conforme a distância real.
    const dest = receiver.isBot
      ? await pickRandomDestCountry(boatId)
      : receiver.country;
    const travelMin = await travelMinutes(lastCountry, dest);

    await enqueueForReceiver(boatId, receiver.id, {
      travelMin,
      destCountry: receiver.isBot ? dest : null,
    });
    console.log(
      `[routing] boat ${boatId} → ${receiver.isBot ? `bot (${dest})` : 'humano'} ` +
      `— viagem de ${lastCountry ?? '?'} a ${dest ?? '?'} em ${travelMin}min`,
    );

    // avisa o receptor que um barco está a caminho (bots não têm token)
    if (!receiver.isBot) {
      const { title, body } = boatComingMessage();
      void avisar(receiver.id, { titulo: title, corpo: body, url: '/receive', tag: 'barco-vindo' });
    }
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
         -- SÓ o que foi explicitamente aprovado. Antes daqui a condição era
         -- "não tem log dizendo rejected/uncertain" — que é VERDADE também
         -- quando não há log NENHUM. E não há log nenhum justamente quando a
         -- moderação quebrou (API fora do ar, cota estourada): o catch em
         -- processModeration registra o erro e não grava linha. O barco ficava
         -- 'active' por padrão, caía neste sweep e navegava SEM NUNCA TER SIDO
         -- MODERADO. Falhava aberto — que é o pior jeito de falhar.
         --
         -- Agora falha fechado: sem carimbo de aprovado, o barco espera. Quem
         -- ficou preso por uma queda da API é recuperado por reenfileirarNaoModerados().
         AND EXISTS (
           SELECT 1 FROM moderation_log ml
           WHERE ml.boat_id = b.id AND ml.verdict = 'approved'
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

/**
 * Rede de segurança do sweep acima.
 *
 * Com o filtro em `EXISTS (verdict = 'approved')`, barco sem log NENHUM para de
 * navegar — que é o certo, porque "sem log" quer dizer "ninguém olhou isto". Mas
 * parar para sempre não é o certo. Dois tipos de barco caem nesse buraco:
 *
 *   1. os que a moderação não conseguiu julgar (API fora, cota estourada) — o
 *      catch de processModeration registra o erro e não grava linha;
 *   2. os de seed, criados direto no banco sem passar por moderação.
 *
 * Os dois querem a mesma coisa: serem julgados. Então é isso que fazemos —
 * roda a moderação de verdade sobre a primeira mensagem do barco. Quem for
 * aprovado segue viagem, quem for rejeitado é arquivado. Nada navega por
 * omissão.
 *
 * De 15 em 15 minutos e no máximo 20 por vez: se a API caiu por uma hora, isto
 * drena a fila aos poucos em vez de despejar tudo de uma vez na volta dela.
 */
export async function reenfileirarNaoModerados(): Promise<void> {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, m.id AS message_id, m.content, m.user_id, m.country_code
         FROM boats b
         JOIN LATERAL (
           SELECT id, content, user_id, country_code
             FROM boat_messages
            WHERE boat_id = b.id
            ORDER BY created_at ASC
            LIMIT 1
         ) m ON TRUE
        WHERE b.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM receiver_queue rq
             WHERE rq.boat_id = b.id AND rq.status = 'pending'
          )
          AND NOT EXISTS (
            SELECT 1 FROM moderation_log ml WHERE ml.boat_id = b.id
          )
          -- respiro: dá tempo de a moderação normal terminar antes de assumir
          -- que ela falhou
          AND b.created_at < NOW() - INTERVAL '10 minutes'
        LIMIT 20`,
    );
    if (rows.length === 0) return;

    console.log(`[remoderar] ${rows.length} barco(s) sem julgamento — moderando agora`);
    for (const r of rows) {
      await processModeration({
        boatId: r.id,
        messageId: r.message_id,
        content: r.content,
        userId: r.user_id,
        countryCode: r.country_code,
      });
    }
  } catch (err) {
    console.error('[remoderar] error', err);
  }
}
