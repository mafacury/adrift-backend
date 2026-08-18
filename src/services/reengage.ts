/**
 * Reconquista — chamar de volta quem parou de aparecer.
 *
 * Quem passa de INACTIVE_DAYS sem dar sinal some do sorteio de receptores
 * (services/routing.ts). A regra existe por um bom motivo: barco mandado para
 * quem não está lá fica parado até expirar, e a viagem inteira empaca. Só que
 * ela vira um alçapão sem maçaneta: o único aviso capaz de trazer a pessoa de
 * volta — o push de "um barco está a caminho" — é exatamente o que deixa de
 * acontecer quando ela sai do sorteio.
 *
 * Aqui a reconquista é desacoplada do roteamento: manda-se um convite que NÃO
 * reserva barco nenhum. Se a pessoa não voltar, não custou uma travessia
 * parada; se voltar, qualquer requisição do app já marca presença (ver o hook
 * em index.ts) e ela volta a ser elegível na mesma hora.
 */
import { pool } from '../db/pool.js';
import { comeBackMessage } from './push.js';
import { avisar } from './notify.js';

/** A partir daqui a pessoa saiu do sorteio e vira candidata a convite. */
const INACTIVE_DAYS = 8;
/** Depois disso a conta é dada por fria — insistir vira perseguição. */
const GIVE_UP_DAYS = 90;
/** Intervalo mínimo entre dois convites para a mesma pessoa. */
const NUDGE_EVERY_DAYS = 10;
/** Teto por rodada, para uma varredura nunca virar disparo em massa. */
const MAX_PER_SWEEP = 50;

export async function reengageSweep(): Promise<void> {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM users
       WHERE oauth_provider IS DISTINCT FROM 'bot'
         AND ban_status = 'active'
         AND fcm_token IS NOT NULL
         AND receiving_paused = FALSE
         AND last_active_at <  NOW() - INTERVAL '${INACTIVE_DAYS} days'
         AND last_active_at >= NOW() - INTERVAL '${GIVE_UP_DAYS} days'
         AND (last_nudge_at IS NULL
              OR last_nudge_at < NOW() - INTERVAL '${NUDGE_EVERY_DAYS} days')
       ORDER BY last_active_at ASC
       LIMIT ${MAX_PER_SWEEP}`,
    );
    if (rows.length === 0) return;

    for (const r of rows) {
      const { title, body } = comeBackMessage();
      void avisar(r.id, { titulo: title, corpo: body, url: '/', tag: 'volte' });
    }
    // marca antes de conferir entrega: push que falhou não deve virar insistência
    await pool.query(
      `UPDATE users SET last_nudge_at = NOW() WHERE id = ANY($1::uuid[])`,
      [rows.map(r => r.id)],
    );
    console.log(`[reengage] ${rows.length} convite(s) enviado(s)`);
  } catch (err) {
    console.error('[reengage] falhou', err);
  }
}
