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
 * Cada varredura marca a própria coluna de "avisado" ANTES de mandar — o
 * UPDATE ... RETURNING marca e seleciona num passo só, então duas passagens do
 * cron nunca pegam a mesma linha. Sem essa marca o mesmo aviso sairia centenas
 * de vezes ao longo das 12 horas.
 *
 * E se NINGUÉM foi alcançado, a marca é DESFEITA. Sem isso o aviso seria dado
 * por entregue quando não saiu de casa — que é exatamente o silêncio que este
 * arquivo veio consertar. Desfazendo, o aviso fica esperando e sai sozinho no
 * minuto em que a pessoa ganhar um canal (assinar o push no navegador, instalar
 * o app). Custa uma consulta por minuto por barco sem canal; entregar o aviso
 * vale mais.
 */

import { pool } from '../db/pool.js';
import { config } from '../config/index.js';
import { avisar, avisoChegou, avisoPrazo, avisoPerdeu } from './notify.js';
import { idiomaDoUsuario } from './i18n.js';

/**
 * Manda e, se falhou, devolve a linha para a fila de avisos.
 *
 * "Falhou" tem duas causas MUITO diferentes, e só uma merece nova tentativa:
 *
 *   a pessoa TEM canal e o envio caiu   → tenta de novo, foi coisa passageira
 *   a pessoa NÃO TEM canal nenhum       → não adianta: a única forma de ganhar
 *                                         um é assinando dentro do app, e quem
 *                                         está dentro do app já está vendo o
 *                                         barco. Reenviar não acrescenta nada.
 *
 * A primeira versão disto não separava os dois e remarcava sempre. Resultado
 * visto em produção em 19/08: seis chegadas sem canal sendo reprocessadas a
 * cada minuto, sete linhas de log por minuto durante as 12 horas da janela — e
 * a enxurrada escondendo as linhas que importavam.
 */
async function avisarOuDesmarcar(
  userId: string, coluna: string, filaId: string, aviso: Parameters<typeof avisar>[1],
): Promise<void> {
  const alcancou = await avisar(userId, aviso);
  if (alcancou > 0) return;

  const { rows } = await pool.query(
    `SELECT (u.fcm_token IS NOT NULL)
          OR EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = u.id) AS tem_canal
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  if (!rows[0]?.tem_canal) return;   // sem canal: marca fica, e acabou

  await pool.query(
    `UPDATE receiver_queue SET ${coluna} = NULL WHERE id = $1`, [filaId],
  );
}

/** O barco atracou agora. */
export async function avisarChegadas(): Promise<void> {
  try {
    // UPDATE ... RETURNING marca e seleciona no mesmo passo: duas instâncias
    // rodando o cron não conseguem pegar a mesma linha.
    const { rows } = await pool.query(
      `UPDATE receiver_queue
          SET avisado_chegada_at = NOW()
        WHERE id IN (
          SELECT id FROM receiver_queue q
           WHERE status = 'pending'
             AND avisado_chegada_at IS NULL
             AND arrives_at <= NOW()
             AND EXISTS (SELECT 1 FROM users u
                          WHERE u.id = q.user_id
                            AND u.oauth_provider IS DISTINCT FROM 'bot')
           LIMIT 200
        )
      RETURNING id, user_id`,
    );
    for (const r of rows) {
      await avisarOuDesmarcar(r.user_id, 'avisado_chegada_at', r.id,
                              await avisoChegou(await idiomaDoUsuario(r.user_id)));
    }
    if (rows.length) console.log(`[alerta] ${rows.length} chegada(s) processada(s)`);
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
          SELECT id FROM receiver_queue q
           WHERE status = 'pending'
             AND EXISTS (SELECT 1 FROM users u
                          WHERE u.id = q.user_id
                            AND u.oauth_provider IS DISTINCT FROM 'bot')
             AND avisado_prazo_at IS NULL
             AND arrives_at <= NOW()
             AND expires_at <= NOW() + ($1 || ' hours')::INTERVAL
             AND expires_at >  NOW()
           LIMIT 200
        )
      RETURNING id, user_id`,
      [String(horas)],
    );
    for (const r of rows) {
      await avisarOuDesmarcar(r.user_id, 'avisado_prazo_at', r.id,
                              avisoPrazo(horas, await idiomaDoUsuario(r.user_id)));
    }
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
          SELECT id FROM receiver_queue q
           WHERE status = 'expired'
             AND EXISTS (SELECT 1 FROM users u
                          WHERE u.id = q.user_id
                            AND u.oauth_provider IS DISTINCT FROM 'bot')
             AND avisado_perda_at IS NULL
             AND avisado_chegada_at IS NOT NULL   -- só quem chegou a ter o barco
             AND expires_at > NOW() - INTERVAL '2 hours'
           LIMIT 200
        )
      RETURNING user_id`,
    );
    // Este NÃO desfaz a marca quando ninguém é alcançado: o barco já foi, e
    // insistir de minuto em minuto não traz nada de volta. Chegada e prazo são
    // acionáveis; perda é só notícia.
    // Não dizemos PARA ONDE ele foi: o reroteamento acontece depois desta
    // marca, e `dest_country` só é preenchido quando o receptor é bot — ou
    // seja, é sempre nulo justamente para a pessoa que perdeu o barco.
    // Melhor uma frase honesta que um destino inventado.
    for (const r of rows) await avisar(r.user_id, avisoPerdeu(await idiomaDoUsuario(r.user_id)));
    if (rows.length) console.log(`[alerta] ${rows.length} perda(s) avisada(s)`);
  } catch (err) {
    console.error('[alerta] perdas', err);
  }
}
