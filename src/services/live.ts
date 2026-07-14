/**
 * Estado "ao vivo" de um barco — há alguém com ele agora? Está escrevendo?
 *
 * Humanos: sinal real — o app do receptor manda POST /boats/:id/typing
 * enquanto a pessoa digita (receiver_queue.typing_at).
 * Bots: prazo de resposta determinístico (mesma fórmula HASHTEXT do sweep
 * em services/bots.ts), então dá para anunciar "escrevendo..." nos minutos
 * finais e estimar a partida. Nunca revela país nem quem é.
 */

export const TYPING_WINDOW_MIN = 7;   // bots: minutos antes da resposta
export const TYPING_FRESH_SEC  = 45;  // humanos: validade do último sinal

export type LiveState = 'typing' | 'waiting' | 'sailing' | 'idle';

export interface LiveQueueRow {
  is_bot: boolean;
  typing_at: string | Date | null;
  responds_at: string | Date;
  arrives_at?: string | Date | null;
}

export function liveStateFrom(
  row: LiveQueueRow | undefined,
  boatStatus: string,
): LiveState {
  if (boatStatus !== 'active') return 'idle';
  if (!row) return 'sailing';
  // ainda em viagem (distância real): está em alto mar, não "com alguém"
  if (row.arrives_at && new Date(row.arrives_at).getTime() > Date.now()) {
    return 'sailing';
  }
  if (row.is_bot) {
    const msLeft = new Date(row.responds_at).getTime() - Date.now();
    if (msLeft <= TYPING_WINDOW_MIN * 60_000) return 'typing';
  } else if (
    row.typing_at &&
    Date.now() - new Date(row.typing_at).getTime() <= TYPING_FRESH_SEC * 1000
  ) {
    return 'typing';
  }
  return 'waiting';
}

/** Segundos até a partida estimada — só para bots (humanos não têm hora marcada). */
export function departsInSeconds(row: LiveQueueRow | undefined): number | null {
  if (!row?.is_bot) return null;
  return Math.max(0, Math.round((new Date(row.responds_at).getTime() - Date.now()) / 1000));
}
