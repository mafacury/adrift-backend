import { pool } from '../db/pool.js';
import { config } from '../config/index.js';

/**
 * Notificações push via serviço do Expo (exp.host).
 * O app registra seu token (ExponentPushToken[...]) em users.fcm_token;
 * aqui enviamos a mensagem quando um barco entra na fila do usuário.
 * Falhas são só logadas — push nunca pode derrubar o fluxo principal.
 */

export async function sendPushToUser(userId: string, title: string, body: string): Promise<void> {
  try {
    const { rows } = await pool.query(
      `SELECT fcm_token FROM users WHERE id = $1`,
      [userId],
    );
    const token: string | null = rows[0]?.fcm_token ?? null;
    if (!token || !token.startsWith('ExponentPushToken')) return;

    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: token,
        title,
        body,
        sound: 'default',
        priority: 'high',
      }),
    });
    const data = (await res.json()) as any;
    const status = data?.data?.status ?? data?.errors?.[0]?.code ?? 'unknown';
    if (status !== 'ok') {
      console.warn(`[push] user ${userId}: ${JSON.stringify(data).slice(0, 300)}`);
      // token inválido/desregistrado → limpa para não insistir
      if (data?.data?.details?.error === 'DeviceNotRegistered') {
        await pool.query(`UPDATE users SET fcm_token = NULL WHERE id = $1`, [userId]);
      }
    } else {
      console.log(`[push] enviado para user ${userId}`);
    }
  } catch (err) {
    console.error('[push] erro ao enviar:', err);
  }
}

/** Mensagem padrão de barco chegando, com o prazo real da fila. */
export function boatArrivedMessage(): { title: string; body: string } {
  const mins = config.boat.queueTimeoutMinutes;
  const prazo = mins >= 60
    ? `${Math.round(mins / 60)} hora${Math.round(mins / 60) > 1 ? 's' : ''}`
    : `${mins} minutos`;
  return {
    title: '⛵ Um barco chegou para você!',
    body: `Ele traz mensagens do mundo. Você tem ${prazo} para responder antes que siga viagem.`,
  };
}
