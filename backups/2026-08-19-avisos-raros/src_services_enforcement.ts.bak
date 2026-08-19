/**
 * Punição automática por histórico de moderação.
 *
 * O `moderation_log` já registrava tudo desde o primeiro dia — e ninguém lia.
 * Cinquenta rejeições seguidas da mesma conta não disparavam nada: todo
 * banimento dependia de alguém abrir o painel e reparar. Contra um bot que cria
 * conta de graça e despeja propaganda, isso é lento demais.
 *
 * O sinal usado aqui é DELIBERADAMENTE só um: rejeição da nossa própria
 * moderação. Denúncia de usuário parece um sinal melhor e é pior — três contas
 * combinadas denunciam qualquer um (é o achado 2 da auditoria de 18/08), e
 * banir por denúncia entregaria a estranhos o poder de derrubar contas alheias.
 * A moderação, mesmo errando, erra sozinha e do mesmo jeito para todo mundo.
 *
 * A escala usa os três estados que `users.ban_status` já tinha:
 *
 *   3 rejeições em 24h → `warned`  — o roteamento para de mandar barcos para a
 *                                    conta, mas ela continua funcionando
 *   5 rejeições em 24h → `banned`  — fim, e os barcos ativos dela saem do mar
 *
 * Janela deslizante de 24 horas: quem foi rejeitado três vezes em março e uma
 * hoje não é spammer, é alguém com azar. Quem leva cinco numa tarde é outra
 * coisa.
 */
import { pool } from '../db/pool.js';
import { config } from '../config/index.js';

/**
 * Chamada depois de cada veredito `rejected`. Nunca lança: é rede de proteção,
 * não pode derrubar o fluxo de moderação que a chamou.
 */
export async function avaliarConduta(userId: string | null): Promise<void> {
  if (!userId) return;
  try {
    // Bot não se pune: o conteúdo dele é nosso, e banir bot só esvazia o mar.
    // Conta já banida também não — de banido não se sobe nem se desce.
    const { rows: quem } = await pool.query(
      `SELECT oauth_provider, ban_status FROM users WHERE id = $1`,
      [userId],
    );
    if (!quem.length) return;
    if (quem[0].oauth_provider === 'bot') return;
    if (quem[0].ban_status === 'banned') return;

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM moderation_log
        WHERE user_id = $1
          AND verdict = 'rejected'
          AND created_at > NOW() - INTERVAL '24 hours'`,
      [userId],
    );
    const rejeicoes = rows[0]?.n ?? 0;

    if (rejeicoes >= config.antispam.autobanBanAt) {
      await pool.query(
        `UPDATE users SET ban_status = 'banned' WHERE id = $1`,
        [userId],
      );
      // Barco de conta banida sai do mar. Sem isto, o que ele já lançou segue
      // viajando de estranho em estranho depois de a conta morrer.
      const { rowCount } = await pool.query(
        `UPDATE boats
            SET status = 'archived', archived_at = NOW(),
                archive_reason = 'autor banido'
          WHERE creator_user_id = $1 AND status = 'active'`,
        [userId],
      );
      console.log(
        `[conduta] usuário ${userId} BANIDO — ${rejeicoes} rejeições em 24h; ` +
        `${rowCount ?? 0} barco(s) arquivado(s)`,
      );
      return;
    }

    if (rejeicoes >= config.antispam.autobanWarnAt && quem[0].ban_status === 'active') {
      await pool.query(
        `UPDATE users SET ban_status = 'warned' WHERE id = $1`,
        [userId],
      );
      console.log(`[conduta] usuário ${userId} ADVERTIDO — ${rejeicoes} rejeições em 24h`);
    }
  } catch (err) {
    console.error('[conduta] falhou ao avaliar', userId, err);
  }
}
