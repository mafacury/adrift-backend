#!/usr/bin/env tsx
/**
 * seed-bots.ts
 * Cria usuários virtuais (bots) e barcos de teste para validar o fluxo do app.
 *
 * Como usar:
 *   npx tsx src/scripts/seed-bots.ts
 *
 * Requer apenas DATABASE_URL no .env (as outras vars do backend não são necessárias).
 * Os barcos aparecerão na aba Jornada de todos os usuários reais cadastrados.
 */

import 'dotenv/config';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌  DATABASE_URL não encontrada no .env');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── Usuários virtuais ──────────────────────────────────────────────────────────

const BOTS = [
  { email: 'marina.silva@adrift.bot',  country: 'BR', oauthId: 'bot-marina'  },
  { email: 'james.ocean@adrift.bot',   country: 'US', oauthId: 'bot-james'   },
  { email: 'yuki.waves@adrift.bot',    country: 'JP', oauthId: 'bot-yuki'    },
  { email: 'sofia.mares@adrift.bot',   country: 'ES', oauthId: 'bot-sofia'   },
  { email: 'kwame.akosua@adrift.bot',  country: 'NG', oauthId: 'bot-kwame'   },
];

// ── Barcos de semente ──────────────────────────────────────────────────────────

interface SeedMessage { country: string; content: string; daysAgo: number; botIdx: number; }
interface SeedBoat    { creatorBotIdx: number; daysAgo: number; messages: SeedMessage[]; }

const SEED_BOATS: SeedBoat[] = [
  {
    creatorBotIdx: 0, // Marina — Brasil
    daysAgo: 8,
    messages: [
      {
        botIdx: 0, country: 'BR', daysAgo: 8,
        content:
          'Olá, mundo! Estou mandando esta mensagem sem saber onde ela vai parar. ' +
          'Se você está lendo isso, saiba que alguém no Brasil estava pensando em você hoje. ' +
          'Espero que a vida esteja sendo gentil com você. ⛵',
      },
      {
        botIdx: 3, country: 'PT', daysAgo: 6,
        content:
          'Que mensagem bonita! Recebi aqui em Lisboa, Portugal. ' +
          'O oceano Atlântico nos separa, mas parece que ele também nos une. ' +
          'Boa viagem, barquinho — que você chegue longe!',
      },
      {
        botIdx: 1, country: 'US', daysAgo: 3,
        content:
          'Found this drifting across the Atlantic, picked it up here in New York. ' +
          'It\'s incredible to think a single message can travel so far. ' +
          'Sending it on with love — keep sailing, little boat. 🌊',
      },
    ],
  },
  {
    creatorBotIdx: 2, // Yuki — Japão
    daysAgo: 12,
    messages: [
      {
        botIdx: 2, country: 'JP', daysAgo: 12,
        content:
          '海を越えてこのメッセージが届くことを願っています。' +
          '世界のどこかで誰かがこれを読んでいると思うだけで、心が温かくなります。' +
          ' (Espero que esta mensagem cruze o oceano. Só de pensar que alguém no mundo a lerá, meu coração se aquece.)',
      },
      {
        botIdx: 1, country: 'AU', daysAgo: 10,
        content:
          'Caught this drifting in from the Pacific, here in Sydney. ' +
          'What a beautiful concept — words sailing between strangers across entire oceans. ' +
          'Adding my voice from Down Under. G\'day, future reader! 🦘',
      },
      {
        botIdx: 4, country: 'NG', daysAgo: 7,
        content:
          'Received in Lagos, Nigeria. The ocean connects us all, regardless of distance. ' +
          'This little boat has already crossed from Asia to Oceania and now Africa. ' +
          'Sending it forward with a wish for peace and prosperity for all.',
      },
      {
        botIdx: 3, country: 'ES', daysAgo: 4,
        content:
          'Desde Barcelona con cariño — este barquito ha viajado por tres continentes. ' +
          'Me emociona pensar que estas palabras nacieron en Japón y llegaron hasta aquí. ' +
          'Que sigas navegando y llegues bien lejos. ¡Bon voyage! ⚓',
      },
    ],
  },
  {
    creatorBotIdx: 4, // Kwame — Nigéria
    daysAgo: 5,
    messages: [
      {
        botIdx: 4, country: 'NG', daysAgo: 5,
        content:
          'From Lagos to wherever you are — hello, friend. ' +
          'I wrote this not knowing who would find it. But I believe the right message ' +
          'always reaches the right person at the right time. You were meant to read this.',
      },
      {
        botIdx: 0, country: 'ZA', daysAgo: 3,
        content:
          'Picked this up in Cape Town, South Africa. ' +
          'Ubuntu — "Eu sou porque nós somos." Este barco é prova disso: ' +
          'existimos uns para os outros, mesmo sem nos conhecer. Que bonito.',
      },
    ],
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function stageFor(countries: number): number {
  if (countries >= 50) return 6;
  if (countries >= 35) return 5;
  if (countries >= 20) return 4;
  if (countries >= 10) return 3;
  if (countries >= 4)  return 2;
  return 1;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const client = await pool.connect();
  try {
    // 1. Criar bots ────────────────────────────────────────────────────────────
    console.log('\n🤖  Criando usuários virtuais...');
    const botIds: string[] = [];

    for (const bot of BOTS) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (email, oauth_provider, oauth_id, reputation_score, ban_status, last_active_at)
         VALUES ($1, 'bot', $2, 100, 'active', '2020-01-01'::timestamptz)
         ON CONFLICT (email) DO UPDATE
           SET last_active_at = '2020-01-01'::timestamptz
         RETURNING id`,
        [bot.email, bot.oauthId],
      );
      botIds.push(rows[0].id);
      console.log(`   ✓ ${bot.email}  (${bot.country})  id=${rows[0].id}`);
    }

    // 2. Criar barcos ──────────────────────────────────────────────────────────
    console.log('\n⛵  Criando barcos de teste...');

    for (const seedBoat of SEED_BOATS) {
      await client.query('BEGIN');
      try {
        const creatorId  = botIds[seedBoat.creatorBotIdx];
        const createdAt  = daysAgo(seedBoat.daysAgo);
        const lastHopAt  = daysAgo(seedBoat.messages.at(-1)!.daysAgo);
        const countries  = [...new Set(seedBoat.messages.map(m => m.country))];
        const uniqueCount = countries.length;
        const stage      = stageFor(uniqueCount);

        // Criar barco
        const boatRes = await client.query<{ id: string }>(
          `INSERT INTO boats (creator_user_id, status, stage, unique_countries, created_at, last_hop_at)
           VALUES ($1, 'active', $2, $3, $4, $5)
           RETURNING id`,
          [creatorId, stage, uniqueCount, createdAt, lastHopAt],
        );
        const boatId = boatRes.rows[0].id;

        // Inserir mensagens
        let prevUserId: string | null = null;
        for (const msg of seedBoat.messages) {
          const userId    = botIds[msg.botIdx];
          const msgDate   = daysAgo(msg.daysAgo);

          const msgRes = await client.query<{ id: string }>(
            `INSERT INTO boat_messages (boat_id, user_id, content, country_code, created_at)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [boatId, userId, msg.content, msg.country, msgDate],
          );
          const msgId = msgRes.rows[0].id;

          // Registrar hop (exceto o primeiro — é a mensagem inicial)
          if (prevUserId !== null) {
            await client.query(
              `INSERT INTO boat_hops (boat_id, from_user_id, to_user_id, country_code, message_id, hopped_at)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [boatId, prevUserId, userId, msg.country, msgId, msgDate],
            );
          }

          // Registrar país
          await client.query(
            `INSERT INTO boat_countries (boat_id, country_code, first_seen_at)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [boatId, msg.country, msgDate],
          );

          // Registrar interação
          await client.query(
            `INSERT INTO boat_country_interactions (boat_id, country_code, user_id)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [boatId, msg.country, userId],
          );

          prevUserId = userId;
        }

        await client.query('COMMIT');

        console.log(
          `   ✓ Barco ${boatId}` +
          `  |  ${uniqueCount} países  |  estágio ${stage}` +
          `  |  ${seedBoat.messages.length} mensagens` +
          `  |  rota: ${seedBoat.messages.map(m => m.country).join(' → ')}`,
        );

        // 3. Colocar barco na fila de todos os usuários reais ──────────────────
        const { rows: realUsers } = await client.query<{ id: string }>(
          `SELECT id FROM users
           WHERE email NOT LIKE '%@adrift.bot'
             AND ban_status = 'active'`,
        );

        if (realUsers.length === 0) {
          console.log('   ⚠️  Nenhum usuário real cadastrado ainda — barco ficará aguardando.');
        } else {
          const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 dias
          for (const user of realUsers) {
            await client.query(
              `INSERT INTO receiver_queue (boat_id, user_id, expires_at, status)
               VALUES ($1, $2, $3, 'pending')
               ON CONFLICT DO NOTHING`,
              [boatId, user.id, expiresAt],
            );
          }
          console.log(`      → Adicionado à fila de ${realUsers.length} usuário(s) real(is)`);
        }

      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    // 4. Resumo ────────────────────────────────────────────────────────────────
    const { rows: summary } = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE email LIKE '%@adrift.bot') AS bots,
         (SELECT COUNT(*) FROM boats WHERE creator_user_id IN (
           SELECT id FROM users WHERE email LIKE '%@adrift.bot'
         )) AS boats,
         (SELECT COUNT(*) FROM receiver_queue WHERE status = 'pending') AS pending_queue`,
    );

    console.log('\n✅  Seed concluído!');
    console.log(`   • ${summary[0].bots} bots  |  ${summary[0].boats} barcos  |  ${summary[0].pending_queue} entradas na fila`);
    console.log('\n   Abra o app, faça login e acesse a aba Jornada para ver os barcos chegando.\n');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('\n❌  Erro no seed:', err.message);
  process.exit(1);
});
