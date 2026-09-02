import { pool, emTransacao } from '../db/pool.js';
import { ensureBots } from './bots.js';

/**
 * A vitrine — o que alguém vê ao clicar "Look around first", sem criar conta.
 *
 * Veio de um comentário no Reddit: a pessoa tentou o app, bateu no formulário
 * de cadastro e desistiu. "Account-required is a barrier for me to play with an
 * app for 5 minutes." Ela tem razão, e a resposta não é usuário `demo` com
 * senha `demo` — quem desiste de um formulário de login não é salvo por outro
 * formulário de login. É um toque.
 *
 * ── O que a pessoa vê ──────────────────────────────────────────────────────
 *
 * Uma conta de mentira com três barcos de verdade: mesmas tabelas, mesmas
 * consultas, mesmas telas. Nada de tela especial de demonstração, que envelhece
 * separada do app e mente sem querer.
 *
 * Os três estão em estágios diferentes de propósito — é a EVOLUÇÃO que explica
 * o produto, e um barco só não mostra isso.
 *
 * As contagens são reais: cada mensagem existe, cada país foi contado. Dava
 * para escrever `stage = 6` e `unique_countries = 195` em três linhas e exibir
 * uma nau imponente, mas aí a barra de progresso mostraria 8 mensagens de 250,
 * e o histórico teria oito linhas para 195 países. Vitrine que não aguenta ser
 * aberta é pior do que vitrine modesta.
 *
 * ── O risco, e onde ele é travado ──────────────────────────────────────────
 *
 * Estes barcos precisam parecer vivos: navegando, com prazo correndo. Mas não
 * podem cair na fila de uma pessoa de verdade — seria um barco falso ocupando
 * as 12 horas de alguém, sem que ela tivesse como saber.
 *
 * A trava mora em `processRouting`, que é o funil único: nenhum barco entra na
 * fila de ninguém sem passar por lá. Uma linha lá protege inclusive os caminhos
 * que forem escritos amanhã por quem nunca ouviu falar da coluna `vitrine`.
 */

/** O e-mail é impossível de receber: ninguém entra por aqui pela porta normal. */
export const EMAIL_VITRINE = 'vitrine@adrift.invalid';

/** Quanto tempo de viagem os barcos da vitrine mostram, em horas. */
const VIAGEM_MIN = 2;
const VIAGEM_MAX = 9;

/**
 * Os três barcos. `paises` é quantos países distintos passam por ele, e
 * `mensagens` quantas mensagens tem no total — ambos reais, gerados abaixo.
 */
const BARCOS = [
  { abertura: 'Primeiro dia no mar. Escrevi isto sem saber quem vai ler — e é exatamente esse o ponto.',
    paises: 3,  mensagens: 4,  diasAtras: 2 },
  { abertura: 'Qual foi a melhor coisa que te aconteceu neste ano? Conta pro barco, ele leva adiante.',
    paises: 9,  mensagens: 12, diasAtras: 24 },
  { abertura: 'O conselho que eu daria para o meu eu de dez anos atrás: viajar. Quais países você já conheceu?',
    paises: 18, mensagens: 27, diasAtras: 71 },
];

/** De onde saem as respostas dos "estranhos". Reaproveita o que já existe. */
const RESPOSTAS: { country: string; content: string }[] = [
  { country: 'PT', content: 'De Lisboa, com saudade — essa palavra que só nós temos. Que ela chegue a quem precisar entender o que sente.' },
  { country: 'US', content: 'Greetings from Seattle! Rainy day here, but this little boat just made it brighter. Passing it on with good vibes.' },
  { country: 'JP', content: '大阪から愛を込めて。この船が世界中を旅していることに感動しました。' },
  { country: 'ES', content: 'Barcelona te saluda, navegante. El Mediterráneo despide a este barquito con un atardecer naranja precioso.' },
  { country: 'FR', content: "Bonjour de Marseille ! Ce petit bateau a traversé tant de mers... Je lui souhaite bon vent et bonne mer." },
  { country: 'IT', content: 'Ciao dal porto di Genova! Qui Colombo sognava oceani. Che questo messaggio arrivi più lontano dei suoi sogni.' },
  { country: 'AU', content: 'Sydney says hi! This boat crossed the entire Pacific to get here. Respect, little sailor. Onward you go!' },
  { country: 'NG', content: 'Lagos, Nigeria — the heartbeat of Africa. This ocean connects all of us. Sending this forward with hope and joy.' },
  { country: 'ZA', content: 'Cape Town here, where two oceans meet. May this boat find calm waters and kind readers ahead.' },
  { country: 'CA', content: 'From Vancouver with maple syrup and good intentions. This message travelled far — help it travel further!' },
  { country: 'AR', content: 'Buenos Aires te manda un tango en forma de mensaje. Que este barquito baile sobre las olas hasta el próximo puerto.' },
  { country: 'MX', content: '¡Hola desde Cancún! El Caribe está precioso hoy. Este barquito merece seguir viajando. ¡Buen viento!' },
  { country: 'IN', content: 'Namaste from Mumbai! The Arabian Sea carries many stories — now it carries yours too. Safe travels, little boat.' },
  { country: 'KR', content: '부산에서 인사드립니다! 이 작은 배가 얼마나 멀리 왔는지 놀랍습니다.' },
  { country: 'DE', content: 'Grüße aus Hamburg, dem Tor zur Welt. Dein Boot hat hier kurz angelegt und segelt jetzt weiter. Gute Reise!' },
  { country: 'GB', content: 'From a grey afternoon in Bristol — this made the day less grey. Sending it on with a bit of English rain.' },
  { country: 'SE', content: 'Hej från Göteborg! Havet här är kallt men snällt. Må din båt hitta lugna vatten.' },
  { country: 'CL', content: 'Desde Valparaíso, puerto de poetas. Neruda habría escrito algo mejor, pero aquí va mi intento: buen viaje.' },
];

function inteiro(min: number, max: number) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Cria a vitrine se ela ainda não existir. Chamada no arranque, como o
 * `ensureBots`. Idempotente: se os três barcos já estão lá, não faz nada.
 */
export async function garantirVitrine(): Promise<void> {
  try {
    const { rows: jaTem } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM boats WHERE vitrine`,
    );
    if (jaTem[0].n >= BARCOS.length) return;

    const bots = [...(await ensureBots()).values()];
    if (!bots.length) {
      console.warn('[vitrine] sem bots — não dá para montar a vitrine agora');
      return;
    }

    // A conta. `receiving_paused` é obrigatório: sem isso, barcos de gente de
    // verdade atracariam num porto que ninguém olha, ficariam as 12 horas e
    // seriam perdidos.
    const { rows: u } = await pool.query(
      `INSERT INTO users (email, country_code, lang, receiving_paused, last_active_at)
       VALUES ($1, 'BR', 'pt', TRUE, NOW())
       ON CONFLICT (email) DO UPDATE SET receiving_paused = TRUE
       RETURNING id`,
      [EMAIL_VITRINE],
    );
    const donoId: string = u[0].id;

    for (const molde of BARCOS) {
      await criarBarco(donoId, bots, molde);
    }
    console.log(`[vitrine] ${BARCOS.length} barcos prontos`);
  } catch (err) {
    console.error('[vitrine] falhou ao montar', err);
  }
}

async function criarBarco(
  donoId: string,
  bots: string[],
  molde: (typeof BARCOS)[number],
): Promise<void> {
  const paises = RESPOSTAS.slice(0, molde.paises);

  await emTransacao(async (c) => {
    const { rows: b } = await c.query(
      `INSERT INTO boats (creator_user_id, status, vitrine, stage, unique_countries,
                          created_at, last_hop_at)
       VALUES ($1, 'active', TRUE, 1, $2, NOW() - ($3 || ' days')::INTERVAL, NOW() - INTERVAL '4 hours')
       RETURNING id`,
      [donoId, paises.length + 1, molde.diasAtras],
    );
    const boatId: string = b[0].id;

    // A abertura é do dono, e é a mais antiga: é ela que a tela mostra como
    // "mensagem inicial" (a consulta pega MIN(created_at)).
    await c.query(
      `INSERT INTO boat_messages (boat_id, user_id, content, country_code, lang, created_at)
       VALUES ($1, $2, $3, 'BR', 'pt', NOW() - ($4 || ' days')::INTERVAL)`,
      [boatId, donoId, molde.abertura, molde.diasAtras],
    );
    await c.query(
      `INSERT INTO boat_countries (boat_id, country_code) VALUES ($1, 'BR')
       ON CONFLICT DO NOTHING`,
      [boatId],
    );

    // As respostas dos estranhos, espalhadas ao longo da viagem. Cada país
    // aparece pelo menos uma vez; o resto se repete, como acontece de verdade.
    let anterior: string = donoId;
    for (let i = 0; i < molde.mensagens - 1; i++) {
      const r = paises[i % paises.length];
      const bot = bots[i % bots.length];
      // do mais antigo para o mais novo, terminando umas horas atrás
      const diasAtras = molde.diasAtras * (1 - (i + 1) / molde.mensagens);

      const { rows: m } = await c.query(
        `INSERT INTO boat_messages (boat_id, user_id, content, country_code, created_at)
         VALUES ($1, $2, $3, $4, NOW() - ($5 || ' days')::INTERVAL)
         RETURNING id`,
        [boatId, bot, r.content, r.country, diasAtras.toFixed(4)],
      );
      await c.query(
        `INSERT INTO boat_hops (boat_id, from_user_id, to_user_id, country_code, message_id, hopped_at)
         VALUES ($1, $2, $3, $4, $5, NOW() - ($6 || ' days')::INTERVAL)`,
        [boatId, anterior, bot, r.country, m[0].id, diasAtras.toFixed(4)],
      );
      await c.query(
        `INSERT INTO boat_countries (boat_id, country_code) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [boatId, r.country],
      );
      await c.query(
        `INSERT INTO boat_country_interactions (boat_id, country_code, user_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [boatId, r.country, bot],
      );
      anterior = bot;
    }

    // O estágio sai das contagens reais, não de um número escolhido a dedo.
    await c.query(
      `UPDATE boats SET
         unique_countries = (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1),
         stage = (
           SELECT MAX(faixa) FROM (VALUES
             (1, 0), (2, 10), (3, 25), (4, 60), (5, 120), (6, 250), (7, 450), (8, 800)
           ) AS s(faixa, minimo)
           WHERE s.minimo <= (SELECT COUNT(*) FROM boat_messages WHERE boat_id = $1)
         )
       WHERE id = $1`,
      [boatId],
    );

    await enfileirarNaVitrine(c, boatId, bots[inteiro(0, bots.length - 1)]);
  });
}

/**
 * A linha de fila que faz o barco parecer navegando.
 *
 * O destinatário é sempre um bot, nunca uma pessoa. `expires_at` fica num
 * futuro absurdo de propósito: é o que impede a varredura de expiração de
 * mexer nestes barcos, e o que impede o bot de responder antes da hora
 * (services/bots.ts responde quando a fila está perto de vencer).
 */
async function enfileirarNaVitrine(
  c: { query: (t: string, v?: unknown[]) => Promise<unknown> },
  boatId: string,
  botId: string,
): Promise<void> {
  await c.query(
    `INSERT INTO receiver_queue (boat_id, user_id, arrives_at, expires_at, status)
     VALUES ($1, $2, NOW() + ($3 || ' hours')::INTERVAL, NOW() + INTERVAL '50 years', 'pending')`,
    [boatId, botId, inteiro(VIAGEM_MIN, VIAGEM_MAX)],
  );
}

/**
 * Manter a vitrine viva.
 *
 * Sem isto, a hora de chegada passa e o barco fica parado no mapa sem o selo
 * "segue viagem em ~4h17" — que é exatamente o sintoma que faz a pessoa achar
 * que o app está quebrado. Empurrar a chegada para a frente antes de ela
 * vencer mantém os três sempre a caminho.
 */
export async function manterVitrine(): Promise<void> {
  try {
    const { rowCount } = await pool.query(
      `UPDATE receiver_queue rq
          SET arrives_at = NOW() + ((2 + FLOOR(RANDOM() * 8)) || ' hours')::INTERVAL
         FROM boats b
        WHERE b.id = rq.boat_id
          AND b.vitrine
          AND rq.status = 'pending'
          AND rq.arrives_at < NOW() + INTERVAL '90 minutes'`,
    );
    if (rowCount) console.log(`[vitrine] ${rowCount} barco(s) seguem viagem`);
  } catch (err) {
    console.error('[vitrine] falhou ao manter', err);
  }
}
