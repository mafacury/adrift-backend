/**
 * refill-queue.mjs
 * Cria barcos frescos e adiciona na fila do usuário mafacury@gmail.com
 * (ou qualquer email passado como argumento: node refill-queue.mjs outro@email.com)
 */
import 'dotenv/config';
import pg from 'pg';

const TARGET_EMAIL = process.argv[2] ?? 'mafacury@gmail.com';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();

try {
  // Achar o usuário alvo
  const { rows: [target] } = await client.query(
    `SELECT id, email FROM users WHERE email = $1`, [TARGET_EMAIL]
  );
  if (!target) { console.error(`❌  Usuário "${TARGET_EMAIL}" não encontrado.`); process.exit(1); }
  console.log(`\n🎯  Usuário: ${target.email}  (${target.id})`);

  // Achar os bots criados pelo seed anterior
  const { rows: bots } = await client.query(
    `SELECT id, email FROM users WHERE email LIKE '%@adrift.bot' ORDER BY created_at`
  );
  if (bots.length < 3) { console.error('❌  Bots não encontrados. Execute npm run seed:bots primeiro.'); process.exit(1); }

  const BOATS = [
    {
      creatorIdx: 1, // James (US)
      messages: [
        { botIdx: 1, country: 'US', daysAgo: 6,
          content: 'From San Francisco with love — I bottled up all my hopes and sent them out to sea. If this reaches you, know that a stranger on the other side of the planet was rooting for you today.' },
        { botIdx: 3, country: 'ES', daysAgo: 4,
          content: 'Llegó a Madrid este mensaje tan bonito. Lo de que alguien en California piense en nosotros... me parece un milagro pequeño y hermoso. Lo mando más lejos todavía.' },
        { botIdx: 2, country: 'JP', daysAgo: 2,
          content: '東京で受け取りました。この小さなメッセージが太平洋を越えてきたことに感動しています。次の人への贈り物として、心を込めて送り届けます。(Recebi em Tóquio. Emocionante que esta mensagem cruzou o Pacífico. Envio com carinho.)' },
      ],
    },
    {
      creatorIdx: 4, // Kwame (NG) — novo barco
      messages: [
        { botIdx: 4, country: 'NG', daysAgo: 9,
          content: 'Lagos, Nigeria. I want the world to know: there is beauty here that no news channel will ever show you. The warmth of our people, the sound of the ocean at dawn. Come see for yourself one day.' },
        { botIdx: 0, country: 'BR', daysAgo: 7,
          content: 'Recebi aqui no Recife. Que coisa mais linda, essa ideia de um barco levando palavras pelo mundo. Você está certo, Kwame — a imprensa só mostra o que divide. Esse app mostra o que une.' },
        { botIdx: 3, country: 'PT', daysAgo: 5,
          content: 'Lisboa recebe este barco carregado de esperança. Que viagem incrível — Nigéria, Brasil e agora Portugal. Três continentes, três línguas, uma mesma humanidade. Seguindo viagem...' },
        { botIdx: 1, country: 'CA', daysAgo: 2,
          content: 'Toronto here. This little boat crossed the Atlantic twice! I am genuinely moved. Adding my voice from Canada and sending it onward into the unknown.' },
      ],
    },
    {
      creatorIdx: 3, // Sofia (ES)
      messages: [
        { botIdx: 3, country: 'ES', daysAgo: 4,
          content: 'Hola, mundo. Hoy me desperté pensando en lo pequeño que me siento a veces y lo grande que se siente el océano. Así que decidí mandar este mensaje para recordarme — y a quien lo lea — que los dos podemos ser las dos cosas.' },
        { botIdx: 2, country: 'AU', daysAgo: 2,
          content: 'Melbourne, Australia. Woke up today feeling small too, Sofia. And then I found your message bobbing along in this app, and I felt a little less alone. Thank you for that. Sending it on.' },
      ],
    },
  ];

  function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d;
  }
  function stageFor(countries) {
    if (countries >= 50) return 6;
    if (countries >= 35) return 5;
    if (countries >= 20) return 4;
    if (countries >= 10) return 3;
    if (countries >= 4)  return 2;
    return 1;
  }

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  let totalBoats = 0;

  for (const seedBoat of BOATS) {
    await client.query('BEGIN');
    try {
      const creatorId  = bots[seedBoat.creatorIdx].id;
      const countries  = [...new Set(seedBoat.messages.map(m => m.country))];
      const uniqueCount = countries.length;
      const stage      = stageFor(uniqueCount);
      const createdAt  = daysAgo(seedBoat.messages[0].daysAgo + 1);
      const lastHopAt  = daysAgo(seedBoat.messages.at(-1).daysAgo);

      const { rows: [{ id: boatId }] } = await client.query(
        `INSERT INTO boats (creator_user_id, status, stage, unique_countries, created_at, last_hop_at)
         VALUES ($1, 'active', $2, $3, $4, $5) RETURNING id`,
        [creatorId, stage, uniqueCount, createdAt, lastHopAt],
      );

      let prevUserId = null;
      for (const msg of seedBoat.messages) {
        const userId  = bots[msg.botIdx].id;
        const msgDate = daysAgo(msg.daysAgo);

        const { rows: [{ id: msgId }] } = await client.query(
          `INSERT INTO boat_messages (boat_id, user_id, content, country_code, created_at)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [boatId, userId, msg.content, msg.country, msgDate],
        );

        if (prevUserId !== null) {
          await client.query(
            `INSERT INTO boat_hops (boat_id, from_user_id, to_user_id, country_code, message_id, hopped_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [boatId, prevUserId, userId, msg.country, msgId, msgDate],
          );
        }
        await client.query(
          `INSERT INTO boat_countries (boat_id, country_code, first_seen_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [boatId, msg.country, msgDate],
        );
        await client.query(
          `INSERT INTO boat_country_interactions (boat_id, country_code, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [boatId, msg.country, userId],
        );
        prevUserId = userId;
      }

      await client.query('COMMIT');

      // Adicionar SOMENTE para o usuário alvo
      await client.query(
        `INSERT INTO receiver_queue (boat_id, user_id, expires_at, status) VALUES ($1,$2,$3,'pending')`,
        [boatId, target.id, expiresAt],
      );

      console.log(`   ✓ Barco ${boatId.slice(0,8)}...  |  ${uniqueCount} países  |  ${seedBoat.messages.length} msgs  |  ${seedBoat.messages.map(m => m.country).join(' → ')}`);
      totalBoats++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  console.log(`\n✅  ${totalBoats} barcos adicionados à fila de ${target.email}`);
  console.log('   Recarregue a aba Jornada no app — os barcos devem aparecer.\n');

} finally {
  client.release();
  await pool.end();
}
