/**
 * As três varreduras que faltavam.
 *
 * Antes disto o app avisava UMA vez, na PARTIDA do barco — que, a 3000 milhas,
 * é horas antes de ter o que fazer. Depois: silêncio na chegada, silêncio nas
 * 12 horas correndo, silêncio na perda. Quem saísse de casa não tinha como
 * saber de nada.
 *
 * A escada agora tem três degraus, e a ordem importa:
 *
 *   CHEGOU      no instante em que atraca — é quando começa a valer
 *   FALTAM 2h   o único que salva barco de gente ocupada
 *   PARTIU      não salva nada, mas fecha a história e diz o que houve
 *
 * Cada varredura marca a própria coluna de "avisado" ANTES de mandar. Rodando
 * de minuto em minuto, sem essa marca o mesmo aviso sairia centenas de vezes ao
 * longo das 12 horas.
 */
import { pool } from '../db/pool.js';
import { config } from '../config/index.js';
import { avisar, avisoChegou, avisoPrazo, avisoPerdeu } from './notify.js';

/** O barco atracou agora. */
export async function avisarChegadas(): Promise<void> {
  try {
    // UPDATE ... RETURNING marca e seleciona no mesmo passo: duas instâncias
    // rodando o cron não conseguem pegar a mesma linha.
    const { rows } = await pool.query(
      `UPDATE receiver_queue
          SET avisado_chegada_at = NOW()
        WHERE id IN (
          SELECT id FROM receiver_queue
           WHERE status = 'pending'
             AND avisado_chegada_at IS NULL
             AND arrives_at <= NOW()
           LIMIT 200
        )
      RETURNING user_id`,
    );
    for (const r of rows) await avisar(r.user_id, avisoChegou());
    if (rows.length) console.log(`[alerta] ${rows.length} chegada(s) avisada(s)`);
  } catch (err) {
    console.error('[alerta] chegadas', err);
  }
}

/** Falta pouco para o barco zarpar. O aviso que de fato salva o barco. */
export async function avisarPrazo(): Promise<void> {
  const horas = config.push.avisoPrazoHoras;
  try {
    const { rows } = await pool.query(
      `UPDATE receiver_queue
          SET avisado_prazo_at = NOW()
        WHERE id IN (
          SELECT id FROM receiver_queue
           WHERE status = 'pending'
             AND avisado_prazo_at IS NULL
             AND arrives_at <= NOW()
             AND expires_at <= NOW() + ($1 || ' hours')::INTERVAL
             AND expires_at >  NOW()
           LIMIT 200
        )
      RETURNING user_id`,
      [String(horas)],
    );
    for (const r of rows) await avisar(r.user_id, avisoPrazo(horas));
    if (rows.length) console.log(`[alerta] ${rows.length} aviso(s) de prazo`);
  } catch (err) {
    console.error('[alerta] prazo', err);
  }
}

/**
 * O barco foi embora.
 *
 * Roda DEPOIS da expiração do scheduler, olhando quem expirou há pouco e ainda
 * não soube. Não salva o barco perdido — serve para a pessoa entender o que
 * houve em vez de achar que o app comeu o barco dela, e para saber que vale a
 * pena voltar.
 */
export async function avisarPerdas(): Promise<void> {
  try {
    const { rows } = await pool.query(
      `UPDATE receiver_queue
          SET avisado_perda_at = NOW()
        WHERE id IN (
          SELECT id FROM receiver_queue
           WHERE status = 'expired'
             AND avisado_perda_at IS NULL
             AND avisado_chegada_at IS NOT NULL   -- só quem chegou a ter o barco
             AND expires_at > NOW() - INTERVAL '2 hours'
           LIMIT 200
        )
      RETURNING user_id`,
    );
    // Não dizemos PARA ONDE ele foi: o reroteamento acontece depois desta
    // marca, e `dest_country` só é preenchido quando o receptor é bot — ou
    // seja, é sempre nulo justamente para a pessoa que perdeu o barco.
    // Melhor uma frase honesta que um destino inventado.
    for (const r of rows) await avisar(r.user_id, avisoPerdeu());
    if (rows.length) console.log(`[alerta] ${rows.length} perda(s) avisada(s)`);
  } catch (err) {
    console.error('[alerta] perdas', err);
  }
}
