import { pool } from '../db/pool.js';
import { processRouting } from './process.js';
import { COUNTRY_LANG } from './country-data.js';
import { STAGE_CASE_SQL } from './progress.js';

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

// Mensagens por IDIOMA — o país de cada resposta é sorteado entre os países
// ATIVOS (tabela countries) ainda não visitados pelo barco; a mensagem sai
// do pool do idioma daquele país (COUNTRY_LANG). {COUNTRY} = nome em inglês,
// {PAIS} = nome em português.
const REPLIES_BY_LANG: Record<string, string[]> = {
  pt: [
    'Recebido aqui em {PAIS} com alegria! Que esse barco leve um pouco do nosso sol pra frente. Boa viagem!',
    'De {PAIS}: adorei encontrar esse barquinho. Vai em frente, o mundo é grande e generoso!',
    'Que mensagem boa de receber. O mar de {PAIS} manda um abraço quente. Segue viagem, marujo!',
  ],
  en: [
    'Picked this up in {COUNTRY} — what a journey this little boat is on! Sending it forward with good vibes.',
    'Hello from {COUNTRY}! Messages like this remind me the world is smaller and kinder than the news says.',
    'Caught your boat here in {COUNTRY}. Safe travels, little sailor — the world awaits!',
  ],
  es: [
    '¡Hola desde {COUNTRY}! Este barquito llegó con buen viento. ¡Que siga su aventura!',
    'Recibido en {COUNTRY} con mucho gusto. Qué bonito saber que hay desconocidos deseándose cosas buenas. ¡Adelante!',
    'Desde {COUNTRY} con cariño: que este barco siga encontrando manos amables. ¡Buen viaje!',
  ],
  fr: [
    'Bonjour de {COUNTRY} ! Ce petit bateau a accosté ici avec élégance. Je le renvoie avec tout mon cœur.',
    'Reçu ici en {COUNTRY}. Quelle belle idée, des mots qui voyagent... Bon vent, petit bateau !',
  ],
  de: [
    'Grüße aus {COUNTRY}! Dein Boot hat hier kurz angelegt und segelt jetzt weiter. Gute Reise!',
    'Hallo aus {COUNTRY}! Deine Nachricht hat mich gefreut. Weiter geht die Reise, kleines Boot!',
  ],
  it: [
    'Ciao da {COUNTRY}! Questo messaggio ha attraversato il mare per arrivare qui. Buon vento, piccola barca!',
    'Ricevuto in {COUNTRY} con un sorriso. Che il viaggio continui ancora a lungo!',
  ],
  nl: [
    'Groeten uit {COUNTRY}! Je bootje heeft hier even aangelegd en vaart nu verder. Goede reis!',
    'Hallo vanuit {COUNTRY}! Wat een verrassing, dit bootje. Vaar maar door, kleine zeiler!',
  ],
  sv: [
    'Hälsningar från {COUNTRY}! Din lilla båt lade till här en stund — nu seglar den vidare. Trevlig resa!',
    'Hej från {COUNTRY}! Vilken resa den här lilla båten gör. Lycka till på haven!',
  ],
  pl: [
    'Pozdrowienia z {COUNTRY}! Twoja łódka zawinęła tu na chwilę — płynie dalej. Szczęśliwej podróży!',
    'Cześć z {COUNTRY}! Co za niespodzianka. Płyń dalej, mała łódko!',
  ],
  el: [
    'Γεια σου από την {COUNTRY}! Το καραβάκι σου άραξε εδώ για λίγο — καλό ταξίδι!',
    'Ελήφθη στην {COUNTRY} με χαμόγελο. Καλή συνέχεια, μικρό καράβι!',
  ],
  tr: [
    '{COUNTRY}\'den selamlar! Küçük teknen burada kısa bir mola verdi — yoluna devam ediyor. İyi yolculuklar!',
    'Merhaba! Mesajın buraya kadar geldi, ne güzel. Rüzgârın bol olsun, küçük tekne!',
  ],
  ru: [
    'Привет из {COUNTRY}! Твоя лодочка ненадолго причалила здесь — и плывёт дальше. Счастливого пути!',
    'Получено в {COUNTRY} с улыбкой. Пусть море будет добрым к тебе, кораблик!',
  ],
  uk: [
    'Привіт з {COUNTRY}! Твій човник причалив тут ненадовго — і пливе далі. Щасливої дороги!',
    'Отримано в {COUNTRY} з посмішкою. Хай море буде лагідним, кораблику!',
  ],
  ar: [
    'تحية من {COUNTRY}! رست قاربك الصغير هنا قليلاً — ويكمل رحلته الآن. رحلة سعيدة!',
    'وصلت رسالتك إلى {COUNTRY}. البحر يجمعنا جميعاً. أكمل الإبحار أيها القارب الصغير!',
  ],
  fa: [
    'درود از {COUNTRY}! قایق کوچکت اینجا لنگر انداخت و حالا ادامه می‌دهد. سفر خوش!',
    'پیامت به {COUNTRY} رسید. دریا همه‌ی ما را به هم می‌رساند. بادبان‌هایت پر باد!',
  ],
  he: [
    'שלום מ{COUNTRY}! הסירה הקטנה שלך עגנה כאן לרגע — וממשיכה במסע. דרך צלחה!',
    'ההודעה שלך הגיעה עד {COUNTRY}. הים מחבר בין כולנו. המשיכי לשוט, סירה קטנה!',
  ],
  hi: [
    '{COUNTRY} से नमस्ते! आपकी छोटी नाव यहाँ कुछ पल रुकी — अब आगे बढ़ रही है। शुभ यात्रा!',
    'आपका संदेश {COUNTRY} तक पहुँचा। समुद्र हम सबको जोड़ता है। बढ़ते रहो, छोटी नाव!',
  ],
  th: [
    'สวัสดีจาก {COUNTRY}! เรือน้อยของคุณแวะพักที่นี่ครู่หนึ่ง — แล้วเดินทางต่อ ขอให้เดินทางปลอดภัย!',
    'ข้อความของคุณมาถึง {COUNTRY} แล้ว ทะเลเชื่อมเราทุกคนไว้ด้วยกัน แล่นต่อไปนะเรือน้อย!',
  ],
  vi: [
    'Xin chào từ {COUNTRY}! Chiếc thuyền nhỏ của bạn đã ghé đây một lát — và tiếp tục hành trình. Thuận buồm xuôi gió!',
    'Tin nhắn của bạn đã đến {COUNTRY}. Biển cả kết nối tất cả chúng ta. Tiếp tục nhé, thuyền nhỏ!',
  ],
  id: [
    'Salam dari {COUNTRY}! Perahu kecilmu singgah di sini sebentar — dan berlayar lagi. Selamat jalan!',
    'Pesanmu sampai di {COUNTRY}. Lautan menghubungkan kita semua. Terus berlayar, perahu kecil!',
  ],
  tl: [
    'Kumusta mula sa {COUNTRY}! Sandaling dumaong ang iyong munting bangka dito — at naglalayag na muli. Maligayang paglalakbay!',
    'Nakarating ang mensahe mo sa {COUNTRY}. Pinag-uugnay tayo ng karagatan. Sige lang, munting bangka!',
  ],
  ja: [
    'こんにちは！この小さな船の旅に感動しました。次の港まで無事に。(Olá! Emocionado com a viagem deste barquinho.)',
    '受け取りました。世界は広いけれど、心はつながっています。(Recebido. O mundo é vasto, mas os corações se conectam.)',
  ],
  ko: [
    '안녕하세요! 이 작은 배의 여행이 정말 감동적이에요. 계속 항해하세요! (Olá! A viagem deste barquinho é emocionante.)',
    '잘 받았습니다. 다음 항구까지 안전한 항해를! (Recebido. Boa viagem até o próximo porto!)',
  ],
  zh: [
    '你好！这只小船的旅程令人感动。愿它一路顺风！(Olá! A viagem deste barquinho é emocionante.)',
    '收到了你的消息。大海把我们连在一起。继续航行吧，小船！(Recebido. O mar nos conecta.)',
  ],
  sw: [
    'Salamu kutoka {COUNTRY}! Mashua yako ndogo ilitia nanga hapa kidogo — sasa inaendelea. Safari njema!',
    'Ujumbe wako umefika {COUNTRY}. Bahari inatuunganisha sote. Endelea kusafiri, mashua ndogo!',
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
      `SELECT rq.id AS queue_id, rq.boat_id, rq.user_id, rq.dest_country, u.email
       FROM receiver_queue rq
       JOIN users u ON u.id = rq.user_id
       WHERE rq.status = 'pending'
         AND u.oauth_provider = 'bot'
         AND (
           -- o barco CHEGOU (viagem por distância real) e o "porto" levou
           -- 5..45 min lendo e escrevendo (estável por entrada)...
           rq.arrives_at + ((5 + ABS(HASHTEXT(rq.id::text)) % 41) || ' minutes')::interval < NOW()
           -- ...mas SEMPRE responde antes de a fila expirar
           OR rq.expires_at < NOW() + INTERVAL '2 minutes'
         )
       LIMIT 20`,
    );
    if (entries.length === 0) return;
    console.log(`[bots] respondendo ${entries.length} barco(s)`);

    for (const entry of entries) {
      // País do carimbo: o destino sorteado na PARTIDA (dest_country) — a
      // viagem até ele durou o tempo da distância real. Entradas antigas
      // (sem destino) sorteiam agora, como antes.
      const { rows: cRows } = await pool.query(
        entry.dest_country
          ? `SELECT code, name_pt, name_en FROM countries WHERE code = $1`
          : `SELECT code, name_pt, name_en FROM countries
             WHERE active
               AND code NOT IN (SELECT country_code FROM boat_countries WHERE boat_id = $1)
             ORDER BY RANDOM() LIMIT 1`,
        [entry.dest_country ?? entry.boat_id],
      );
      // fallback: qualquer país ativo
      const c = cRows[0] ?? (await pool.query(
        `SELECT code, name_pt, name_en FROM countries WHERE active ORDER BY RANDOM() LIMIT 1`,
      )).rows[0];
      if (!c) { console.warn('[bots] nenhum país ativo — pulando'); continue; }

      const country = c.code;
      const lang = COUNTRY_LANG[country] ?? 'en';
      const pool_ = REPLIES_BY_LANG[lang] ?? REPLIES_BY_LANG.en;
      // 85% das vezes o bot escreve; 15% só manda seguir
      const content = Math.random() < 0.85
        ? pool_[Math.floor(Math.random() * pool_.length)]
            .replaceAll('{COUNTRY}', c.name_en)
            .replaceAll('{PAIS}', c.name_pt)
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
             stage = ${STAGE_CASE_SQL},
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
