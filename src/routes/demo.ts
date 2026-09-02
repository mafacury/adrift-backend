import { FastifyInstance } from 'fastify';
import { pool, emTransacao } from '../db/pool.js';
import { ensureBots } from '../services/bots.js';
import { sendPushToUser, boatComingMessage } from '../services/push.js';

/**
 * Rota TEMPORÁRIA de demonstração.
 * POST /demo/boat — cria um barco de teste (vindo de usuários virtuais)
 * e o coloca imediatamente na fila do usuário logado, para validar o
 * funcionamento da tela Jornada.
 *
 * Remover este arquivo (e o register em index.ts) quando o app entrar
 * em produção de verdade.
 */

// Pool de mensagens por país — cada barco demo sorteia um trajeto diferente
const MESSAGE_POOL: { country: string; content: string }[] = [
  { country: 'BR', content: 'Do Rio de Janeiro para o mundo: que este barquinho leve um pouco do calor daqui. Se você está lendo, um abraço brasileiro!' },
  { country: 'BR', content: 'Recife, Brasil. O mar daqui é morno e generoso. Desejo que sua semana seja igual. Segue viagem, barquinho!' },
  { country: 'PT', content: 'De Lisboa, com saudade — essa palavra que só nós temos. Que ela chegue a quem precisar entender o que sente.' },
  { country: 'US', content: 'Greetings from Seattle! Rainy day here, but this little boat just made it brighter. Passing it on with good vibes.' },
  { country: 'US', content: 'New York checking in. Eight million people here, and somehow this message found me. The universe is funny like that.' },
  { country: 'JP', content: '大阪から愛を込めて。この船が世界中を旅していることに感動しました。(De Osaka com amor. Estou emocionado com a viagem deste barco.)' },
  { country: 'ES', content: 'Barcelona te saluda, navegante. El Mediterráneo despide a este barquito con un atardecer naranja precioso.' },
  { country: 'FR', content: 'Bonjour de Marseille ! Ce petit bateau a traversé tant de mers... Je lui souhaite bon vent et bonne mer.' },
  { country: 'IT', content: 'Ciao dal porto di Genova! Qui Colombo sognava oceani. Che questo messaggio arrivi più lontano dei suoi sogni.' },
  { country: 'AU', content: 'Sydney says hi! This boat crossed the entire Pacific to get here. Respect, little sailor. Onward you go!' },
  { country: 'NG', content: 'Lagos, Nigeria — the heartbeat of Africa. This ocean connects all of us. Sending this forward with hope and joy.' },
  { country: 'ZA', content: 'Cape Town here, where two oceans meet. May this boat find calm waters and kind readers ahead.' },
  { country: 'CA', content: 'From Vancouver with maple syrup and good intentions. This message travelled far — help it travel further!' },
  { country: 'AR', content: 'Buenos Aires te manda un tango en forma de mensaje. Que este barquito baile sobre las olas hasta el próximo puerto.' },
  { country: 'MX', content: '¡Hola desde Cancún! El Caribe está precioso hoy. Este barquito merece seguir viajando. ¡Buen viento!' },
  { country: 'IN', content: 'Namaste from Mumbai! The Arabian Sea carries many stories — now it carries yours too. Safe travels, little boat.' },
  { country: 'KR', content: '부산에서 인사드립니다! 이 작은 배가 얼마나 멀리 왔는지 놀랍습니다. (Saudações de Busan! Impressionante o quanto este barquinho viajou.)' },
  { country: 'NZ', content: 'Kia ora from Auckland! End of the world down here, but your message made it. Nothing is too far away after all.' },
  { country: 'GB', content: 'London calling! Grey skies, warm tea, and a lovely surprise: your boat docked here. Sending it on with a smile.' },
  { country: 'DE', content: 'Grüße aus Hamburg, der Stadt der Häfen! Dein Boot hat hier kurz angelegt und segelt jetzt weiter. Gute Reise!' },
];

function pickRandom<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  while (out.length < n && copy.length > 0) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

export async function demoRoutes(app: FastifyInstance) {
  app.post('/demo/boat', {}, async (req, reply) => {
    const userId = (req as any).user?.id;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

    // Só administrador. Aberta a todos, esta rota fabricava barcos com
    // mensagens prontas sem limite nenhum — e por cima do teto de 3 barcos
    // ativos, porque os barcos nascem em nome dos bots e o teto olha para o
    // criador. Qualquer pessoa inflava as estatísticas da home e o ranking.
    if ((req as any).user?.role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden' });
    }

    // 1. Garantir que os bots existem (ativos — eles também recebem barcos)
    const botIds = [...(await ensureBots()).values()];

    // 2. Sortear trajeto: 2 a 4 mensagens de países distintos
    const hopCount = 2 + Math.floor(Math.random() * 3);
    const messages = pickRandom(MESSAGE_POOL, hopCount);
    const countries = [...new Set(messages.map(m => m.country))];
    const stage = countries.length >= 4 ? 2 : 1;

    // Transação de verdade — ver `emTransacao` em db/pool.ts. O barco de
    // demonstração é fabricado inteiro (barco, mensagens, pulos, países) ou não
    // é fabricado: metade dele seria um barco falso com buraco no histórico,
    // dentro do museu, indistinguível de um bug de verdade.
    const boatId = await emTransacao(async (c) => {
      const creatorId = botIds[Math.floor(Math.random() * botIds.length)];
      const daysTotal = hopCount * 2;

      const { rows: [{ id: novoBarco }] } = await c.query(
        `INSERT INTO boats (creator_user_id, status, stage, unique_countries, created_at, last_hop_at)
         VALUES ($1, 'active', $2, $3, NOW() - ($4 || ' days')::INTERVAL, NOW() - INTERVAL '1 day')
         RETURNING id`,
        [creatorId, stage, countries.length, daysTotal],
      );

      let prevUserId: string | null = null;
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const botId = botIds[(i + 1) % botIds.length];
        const daysAgo = daysTotal - i * 2;

        const { rows: [{ id: msgId }] } = await c.query(
          `INSERT INTO boat_messages (boat_id, user_id, content, country_code, created_at)
           VALUES ($1, $2, $3, $4, NOW() - ($5 || ' days')::INTERVAL)
           RETURNING id`,
          [novoBarco, botId, msg.content, msg.country, daysAgo],
        );

        if (prevUserId !== null) {
          await c.query(
            `INSERT INTO boat_hops (boat_id, from_user_id, to_user_id, country_code, message_id, hopped_at)
             VALUES ($1, $2, $3, $4, $5, NOW() - ($6 || ' days')::INTERVAL)`,
            [novoBarco, prevUserId, botId, msg.country, msgId, daysAgo],
          );
        }
        await c.query(
          `INSERT INTO boat_countries (boat_id, country_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [novoBarco, msg.country],
        );
        await c.query(
          `INSERT INTO boat_country_interactions (boat_id, country_code, user_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [novoBarco, msg.country, botId],
        );
        prevUserId = botId;
      }

      return novoBarco as string;
    });

    // 3. Colocar na fila do usuário logado — viagem curta (~15s) para
    //    testar a silhueta se aproximando antes de atracar.
    await pool.query(
      `INSERT INTO receiver_queue (boat_id, user_id, arrives_at, expires_at, status)
       VALUES ($1, $2, NOW() + INTERVAL '15 seconds', NOW() + INTERVAL '7 days', 'pending')`,
      [boatId, userId],
    );

    // notificação: barco a caminho
    const { title, body } = boatComingMessage();
    void sendPushToUser(userId, title, body);

    return reply.send({
      status: 'created',
      boatId,
      countries,
      messages: messages.length,
    });
  });
}
