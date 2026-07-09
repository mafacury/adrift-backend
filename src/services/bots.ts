import { pool } from '../db/pool.js';
import { processRouting } from './process.js';

/**
 * Usuários virtuais (bots) espalhados pelo mundo.
 * Eles participam do roteamento como receptores reais: quando um barco
 * chega na fila de um bot, o sweep responde em alguns minutos com uma
 * mensagem do país dele e manda o barco seguir viagem — assim os barcos
 * dos usuários reais viajam pelo mundo e a rota aparece no mapa.
 */

export interface Bot {
  email: string;
  oauthId: string;
  country: string;
}

export const BOTS: Bot[] = [
  { email: 'marina.silva@adrift.bot',  oauthId: 'bot-marina', country: 'BR' },
  { email: 'james.ocean@adrift.bot',   oauthId: 'bot-james',  country: 'US' },
  { email: 'yuki.waves@adrift.bot',    oauthId: 'bot-yuki',   country: 'JP' },
  { email: 'sofia.mares@adrift.bot',   oauthId: 'bot-sofia',  country: 'ES' },
  { email: 'kwame.akosua@adrift.bot',  oauthId: 'bot-kwame',  country: 'NG' },
  { email: 'claire.paris@adrift.bot',  oauthId: 'bot-claire', country: 'FR' },
  { email: 'hans.berlin@adrift.bot',   oauthId: 'bot-hans',   country: 'DE' },
  { email: 'priya.mumbai@adrift.bot',  oauthId: 'bot-priya',  country: 'IN' },
  { email: 'jack.sydney@adrift.bot',   oauthId: 'bot-jack',   country: 'AU' },
  { email: 'emma.toronto@adrift.bot',  oauthId: 'bot-emma',   country: 'CA' },
  { email: 'minjun.seoul@adrift.bot',  oauthId: 'bot-minjun', country: 'KR' },
  { email: 'lucia.cancun@adrift.bot',  oauthId: 'bot-lucia',  country: 'MX' },
];

const BOT_COUNTRY = new Map(BOTS.map(b => [b.email, b.country]));

// Respostas por país — curtas, calorosas, no idioma local
const REPLIES: Record<string, string[]> = {
  BR: [
    'Recebido aqui no Brasil com alegria! Que esse barco leve um pouco do nosso sol pra frente. Boa viagem!',
    'Do litoral brasileiro: adorei encontrar esse barquinho. Vai em frente, o mundo é grande e generoso!',
    'Que mensagem boa de receber. O mar daqui manda um abraço quente. Segue viagem, marujo!',
  ],
  US: [
    'Picked this up in the United States — what a journey this little boat is on! Sending it forward with good vibes.',
    'Hello from the US! Messages like this remind me the world is smaller and kinder than the news says.',
    'Caught your boat on this side of the ocean. Safe travels, little sailor — the world awaits!',
  ],
  JP: [
    '日本からこんにちは！この小さな船の旅に感動しました。次の港まで無事に。 (Olá do Japão! Emocionado com a viagem deste barquinho.)',
    '東京湾で受け取りました。世界は広いけれど、心はつながっています。(Recebido na baía de Tóquio. O mundo é vasto, mas os corações se conectam.)',
    'こんにちは！素敵なメッセージをありがとう。良い航海を！(Olá! Obrigado pela linda mensagem. Boa navegação!)',
  ],
  ES: [
    '¡Hola desde España! Este barquito llegó con el sol del Mediterráneo. ¡Buen viento y buena mar!',
    'Recibido en la costa española. Qué bonito saber que hay desconocidos deseándose cosas buenas. ¡Adelante!',
    'Desde Barcelona con cariño: que este barco siga encontrando manos amables. ¡Bon voyage!',
  ],
  NG: [
    'Greetings from Nigeria! The ocean connects all of us — sending this boat forward with hope and joy.',
    'Received in Lagos with a big smile. Keep sailing, little one, Africa wishes you well!',
    'From the Gulf of Guinea: this message made my day. Onward, brave little boat!',
  ],
  FR: [
    'Bonjour de France ! Ce petit bateau a accosté ici avec élégance. Je le renvoie avec tout mon cœur.',
    'Reçu sur la côte française. Quelle belle idée, des mots qui voyagent... Bon vent, petit bateau !',
    'Salut du port de Marseille ! Que ton voyage continue longtemps. Bonne mer !',
  ],
  DE: [
    'Grüße aus Deutschland! Dein Boot hat hier kurz angelegt und segelt jetzt weiter. Gute Reise!',
    'In Hamburg empfangen — der Stadt der Häfen. Möge dieses Boot noch viele Länder sehen!',
    'Hallo! Deine Nachricht hat mich gefreut. Weiter geht die Reise, kleines Boot!',
  ],
  IN: [
    'Namaste from India! May this boat carry peace to every shore it touches. 🙏',
    'Received in Mumbai with warm wishes. The Arabian Sea sends you onward, little traveler!',
    'Hello from India! So happy this message found me. Safe sailing to the next friend!',
  ],
  AU: [
    'G\'day from Australia! Your boat crossed half the planet to get here — respect! Sending it onward.',
    'Caught this drifting near Sydney. What a champion little boat. Onward you go, mate!',
    'Hello from Down Under! The Pacific says hi. Fair winds for the rest of your journey!',
  ],
  CA: [
    'Hello from Canada! Your boat docked here between two oceans. Sending it forward with maple-sweet wishes.',
    'Received in Toronto, eh! What a lovely surprise. Keep going, little boat, the world is watching!',
    'Greetings from the Great White North — may your journey stay warm even in cold waters!',
  ],
  KR: [
    '한국에서 인사드려요! 이 작은 배의 여행이 정말 감동적이에요. (Saudações da Coreia! A viagem deste barquinho é emocionante.)',
    '부산항에서 받았습니다. 다음 항구까지 안전한 항해를! (Recebido no porto de Busan. Boa viagem até o próximo porto!)',
    '안녕하세요! 좋은 메시지 고마워요. 계속 항해하세요! (Olá! Obrigado pela boa mensagem. Continue navegando!)',
  ],
  MX: [
    '¡Hola desde México! El Caribe recibió tu barquito con olas suaves. ¡Que siga su aventura!',
    'Recibido en Cancún con mucho gusto. ¡Este barco ya es parte de nuestra historia! ¡Buen viaje!',
    '¡Saludos mexicanos! Que este barquito encuentre siempre puertos amigos. ¡Ándale, adelante!',
  ],
};

/** Cria/atualiza os bots e os marca como ativos (elegíveis para receber barcos). */
export async function ensureBots(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const bot of BOTS) {
    const { rows } = await pool.query(
      `INSERT INTO users (email, oauth_provider, oauth_id, reputation_score, ban_status, last_active_at)
       VALUES ($1, 'bot', $2, 100, 'active', NOW())
       ON CONFLICT (email) DO UPDATE SET last_active_at = NOW()
       RETURNING id`,
      [bot.email, bot.oauthId],
    );
    ids.set(bot.email, rows[0].id);
  }
  console.log(`[bots] ${ids.size} usuários virtuais ativos`);
  return ids;
}

/**
 * Sweep do motor de bots: cada barco na fila de um bot ganha um "tempo de
 * resposta humano" aleatório entre 30 min e 4 h. O sorteio é determinístico
 * por entrada da fila (hash do id), então não precisa de coluna nova e o
 * mesmo barco sempre tem o mesmo prazo.
 */
export async function botRespondSweep(): Promise<void> {
  try {
    const { rows: entries } = await pool.query(
      `SELECT rq.id AS queue_id, rq.boat_id, rq.user_id, u.email
       FROM receiver_queue rq
       JOIN users u ON u.id = rq.user_id
       WHERE rq.status = 'pending'
         AND u.oauth_provider = 'bot'
         -- prazo aleatório 30..240 min, estável por entrada
         AND rq.queued_at < NOW() - ((30 + ABS(HASHTEXT(rq.id::text)) % 211) || ' minutes')::interval
       LIMIT 20`,
    );
    if (entries.length === 0) return;
    console.log(`[bots] respondendo ${entries.length} barco(s)`);

    for (const entry of entries) {
      const country = BOT_COUNTRY.get(entry.email) ?? 'XX';
      const pool_ = REPLIES[country] ?? [];
      // 85% das vezes o bot escreve; 15% só manda seguir
      const content = pool_.length && Math.random() < 0.85
        ? pool_[Math.floor(Math.random() * pool_.length)]
        : null;

      await pool.query('BEGIN');
      try {
        const { rowCount } = await pool.query(
          `UPDATE receiver_queue SET status = 'delivered'
           WHERE id = $1 AND status = 'pending'`,
          [entry.queue_id],
        );
        if (!rowCount) { await pool.query('ROLLBACK'); continue; }

        let messageId: string | null = null;
        if (content) {
          const { rows } = await pool.query(
            `INSERT INTO boat_messages (boat_id, user_id, content, country_code)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [entry.boat_id, entry.user_id, content, country],
          );
          messageId = rows[0].id;
        }

        const { rows: prevHop } = await pool.query(
          `SELECT to_user_id FROM boat_hops WHERE boat_id = $1 ORDER BY hopped_at DESC LIMIT 1`,
          [entry.boat_id],
        );
        const fromUserId = prevHop[0]?.to_user_id ?? null;

        await pool.query(
          `INSERT INTO boat_hops (boat_id, from_user_id, to_user_id, country_code, message_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [entry.boat_id, fromUserId, entry.user_id, country, messageId],
        );
        await pool.query(
          `INSERT INTO boat_countries (boat_id, country_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [entry.boat_id, country],
        );
        if (messageId) {
          await pool.query(
            `INSERT INTO boat_country_interactions (boat_id, country_code, user_id)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [entry.boat_id, country, entry.user_id],
          );
        }
        await pool.query(
          `UPDATE boats
           SET
             unique_countries = (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1),
             stage = CASE
               WHEN (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 50 THEN 6
               WHEN (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 35 THEN 5
               WHEN (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 20 THEN 4
               WHEN (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 10 THEN 3
               WHEN (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 4  THEN 2
               ELSE 1
             END,
             last_hop_at = NOW()
           WHERE id = $1`,
          [entry.boat_id],
        );
        // bot continua ativo como receptor
        await pool.query(`UPDATE users SET last_active_at = NOW() WHERE id = $1`, [entry.user_id]);

        await pool.query('COMMIT');
      } catch (err) {
        await pool.query('ROLLBACK');
        console.error(`[bots] falha ao responder barco ${entry.boat_id}:`, err);
        continue;
      }

      console.log(`[bots] ${entry.email} (${country}) → barco ${entry.boat_id} segue viagem`);
      await processRouting({ boatId: entry.boat_id, fromUserId: entry.user_id });
    }
  } catch (err) {
    console.error('[bots] sweep error', err);
  }
}
