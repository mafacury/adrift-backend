import { pool } from '../db/pool.js';
import { config } from '../config/index.js';
import { ajustesDoFluxo } from './ajustes.js';

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

/** Aviso ao criador de que seu barco recebeu um presente. */
export function boatGiftMessage(): { title: string; body: string } {
  return {
    title: '🎁 Seu barco recebeu um presente!',
    body: 'Seu barco está indo muito bem e acaba de receber um presente. Veja a jornada dele!',
  };
}

/** Aviso de que um barco está navegando até a pessoa (aparece no horizonte). */
export function boatComingMessage(): { title: string; body: string } {
  return {
    title: '🌅 Um barco está a caminho!',
    body: 'Avistado no horizonte — logo ele chega até você. Prepare suas palavras.',
  };
}

/**
 * Convite para quem sumiu. Não promete barco nenhum de propósito: se
 * prometesse, teria de reservar um, e ele ficaria parado horas caso a pessoa
 * não voltasse (ver services/reengage.ts).
 */
export function comeBackMessage(): { title: string; body: string } {
  const opcoes = [
    { title: '🌊 O mar andou movimentado',
      body:  'Faz um tempo que você não aparece. Tem barco cruzando o horizonte agora mesmo.' },
    { title: '⛵ Seu porto está aberto',
      body:  'Ninguém atraca num porto fechado. Passe por aqui e deixe um barco te encontrar.' },
    { title: '🧭 O oceano continua aí',
      body:  'Enquanto você esteve fora, barcos seguiram viagem. Volte para pegar o próximo.' },
  ];
  return opcoes[Math.floor(Math.random() * opcoes.length)];
}

/** Mensagem padrão de barco chegando, com o prazo real da fila. */
export async function boatArrivedMessage(): Promise<{ title: string; body: string }> {
  const { prazoRespostaHoras } = await ajustesDoFluxo();
  const prazo = `${prazoRespostaHoras} hora${prazoRespostaHoras > 1 ? 's' : ''}`;
  return {
    title: '⛵ Um barco chegou para você!',
    body: `Ele traz mensagens do mundo. Você tem ${prazo} para responder antes que siga viagem.`,
  };
}
