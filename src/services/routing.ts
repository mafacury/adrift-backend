import { pool, emTransacao } from '../db/pool.js';
import { config } from '../config/index.js';
import { STAGE_CASE_SQL } from './progress.js';
import { ajustesDoFluxo } from './ajustes.js';

// ── Fluxo dos barcos ───────────────────────────────────────────────────────
// Viagem com distância REAL: tempo = base + km/velocidade (±20% de "maré").
// Humanos têm prioridade (com proteções anti-enchente); bots são o oceano de
// reserva que mantém tudo em movimento — a mesma regra serve para 3 usuários
// ou 30 mil.
// Estes números são PADRÃO, não lei: o valor que vale vem de
// `ajustesDoFluxo()`, girável no painel sem deploy (migração 031). O padrão é
// o que resta quando a chave não existe, não é número, ou o banco está fora —
// no pior caso o app se comporta como antes de existir painel.
const DEFAULT_KM = 7000;  // distância padrão quando falta coordenada

/**
 * Cota diária por pessoa — o item de equilíbrio do fluxo.
 *
 * A oferta de barcos cresce junto com a comunidade (cada pessoa lança os seus,
 * e cada barco dá ~9 pulos por dia), então sem teto o que cada um recebe
 * depende da razão barcos/pessoas, não de um número desejado. Hoje seriam ~34
 * por dia para cada humano; num app grande, o mesmo descontrole com outra
 * conta. Fixar a cota resolve nos dois extremos e é o número que a gente
 * realmente quer decidir: quantos barcos um dia de app entrega a alguém.
 *
 * O excedente não se perde — vai para os bots, que existem justamente para ser
 * o oceano de reserva.
 */
/**
 * O espaçamento sai da própria cota — 8 por dia é um a cada 3 h. Por isso ele
 * é calculado e não ajustável: são o mesmo botão visto de dois jeitos, e dois
 * botões para a mesma coisa é como se acerta um e esquece o outro.
 */
function espacamentoMin(barcosPorDia: number): number {
  return Math.round((24 * 60) / Math.max(1, barcosPorDia));
}

/**
 * Revisita: um barco pode voltar a quem já o recebeu, desde que a passagem
 * tenha sido há muito tempo E ele tenha mudado bastante desde então.
 *
 * A regra "viu uma vez, nunca mais" protege a surpresa, mas numa comunidade
 * pequena ela estrangula: com 34 barcos vivos, o único usuário ativo já tinha
 * visto 27 e ficava sem NENHUM elegível. Um barco com dezenas de paradas novas
 * é, na prática, outro barco — as mensagens que ele carrega são outras.
 */
const REVISIT_DAYS     = 21;
const REVISIT_NEW_MSGS = 15;

/**
 * Esquecimento: por que as exclusões têm prazo.
 *
 * Três regras tiram um barco da lista de alguém: já recebeu (revisita), deixou
 * expirar, e deixou passar vezes demais. As duas últimas nasceram SEM prazo —
 * "quem deixou ESTE barco expirar não o recebe de novo", ponto final. Só somam,
 * nunca esquecem.
 *
 * Uma exclusão permanente por evento recorrente é uma torneira que só fecha. O
 * oceano de cada pessoa encolhe monotonicamente até zero, e o app fica mudo sem
 * nada quebrar: nenhum erro, nenhum log, os barcos simplesmente passam todos
 * pelos bots. Em 04/09/2026 foi exatamente isso — o dono não recebia nada havia
 * dois dias, e dos 47 barcos ativos ZERO conseguiam achar um humano. A conta
 * fechava: 5 dele, 15 na revisita, 19 expirados, 8 deixados passar. Os 19 e os
 * 8 eram para sempre.
 *
 * Repare que a revisita já tinha recebido este conserto (ver o comentário dela
 * acima, sobre estrangular comunidade pequena). Estas duas ficaram para trás.
 * Agora as três esquecem.
 *
 * Um barco que atracou de madrugada e expirou não é uma escolha da pessoa — é o
 * fuso horário. Custar o barco para sempre é caro demais para um acidente.
 * "Deixar passar" é escolha, sim, mas escolha sobre o barco de HOJE: quinze
 * mensagens depois ele é outro assunto.
 *
 * Os prazos vêm de `ajustesDoFluxo()` (padrão 14 e 30 dias) e giram no painel.
 * A hora do evento é lida em `expires_at` nos dois casos: para 'expired' ela é
 * o instante exato; para 'skipped' é o fim do prazo daquela visita, até 12h
 * depois do toque — erro de 1,6% numa janela de 30 dias, e sempre para o lado
 * conservador.
 */

export interface Receiver { id: string; isBot: boolean; country: string | null }

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Minutos de viagem entre dois países (coordenadas na tabela countries). */
export async function travelMinutes(
  fromCountry: string | null,
  toCountry: string | null,
): Promise<number> {
  let km = DEFAULT_KM;
  if (fromCountry && toCountry) {
    const { rows } = await pool.query(
      `SELECT code, lat, lon FROM countries WHERE code IN ($1, $2)`,
      [fromCountry, toCountry],
    );
    const a = rows.find(r => r.code === fromCountry);
    const b = rows.find(r => r.code === toCountry);
    if (a?.lat != null && b?.lat != null) {
      km = haversineKm(a.lat, a.lon, b.lat, b.lon);
    }
  }
  const a = await ajustesDoFluxo();
  const jitter = 0.8 + Math.random() * 0.4; // ±20% de maré
  return Math.min(
    a.travessiaTetoMin,
    Math.round((a.travessiaBaseMin + km / a.travessiaKmPorMin) * jitter),
  );
}

/** País de destino para um bot: ativo e ainda não visitado (senão, qualquer ativo). */
export async function pickRandomDestCountry(boatId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT code FROM countries
     WHERE active
       AND code NOT IN (SELECT country_code FROM boat_countries WHERE boat_id = $1)
     ORDER BY RANDOM() LIMIT 1`,
    [boatId],
  );
  if (rows[0]) return rows[0].code;
  const { rows: any_ } = await pool.query(
    `SELECT code FROM countries WHERE active ORDER BY RANDOM() LIMIT 1`,
  );
  return any_[0]?.code ?? null;
}

export async function pickNextReceiver(boatId: string): Promise<Receiver | null> {
  const { maxIgnoresPerUser } = config.boat;

  // FASE 1 — humanos elegíveis, priorizando quem está há mais tempo sem
  // receber (anti-seca), com espaçamento entre chegadas e teto de fila
  // (anti-enchente).
  const ajustes = await ajustesDoFluxo();
  const gapMin = espacamentoMin(ajustes.barcosPorDia);
  const { rows: humans } = await pool.query(
    `SELECT u.id, u.country_code
     FROM users u
     WHERE u.ban_status = 'active'
       AND u.receiving_paused = FALSE
       AND u.oauth_provider IS DISTINCT FROM 'bot'
       AND u.last_active_at >= NOW() - INTERVAL '7 days'
       AND u.reputation_score > 0
       -- não é o criador
       AND u.id != (SELECT creator_user_id FROM boats WHERE id = $1)
       -- nunca viu este barco — ou viu há muito tempo e ele mudou bastante
       AND NOT EXISTS (
         SELECT 1 FROM boat_hops h
         WHERE h.boat_id = $1 AND h.to_user_id = u.id
           AND (
             h.hopped_at > NOW() - INTERVAL '${REVISIT_DAYS} days'
             OR (SELECT COUNT(*) FROM boat_messages m
                 WHERE m.boat_id = $1 AND m.created_at > h.hopped_at) < ${REVISIT_NEW_MSGS}
           )
       )
       -- deixou este barco passar vezes demais — contando só o que é recente.
       -- A fonte passou a ser a fila e nao a tabela boat_ignore_counts: aquele
       -- contador não guarda QUANDO: é um número que só sobe, e sem data não
       -- há como esquecer. A fila tem a data de cada visita.
       AND (SELECT COUNT(*) FROM receiver_queue rqi
            WHERE rqi.boat_id = $1 AND rqi.user_id = u.id
              AND rqi.status = 'skipped'
              AND rqi.expires_at > NOW() - INTERVAL '${ajustes.janelaDeixarPassarDias} days'
           ) < $2
       -- deixou este barco expirar — fica de fora durante a carência, não para
       -- sempre. Ver o bloco "Esquecimento" no topo.
       AND NOT EXISTS (
         SELECT 1 FROM receiver_queue rqe
         WHERE rqe.boat_id = $1 AND rqe.user_id = u.id
           AND rqe.status = 'expired'
           AND rqe.expires_at > NOW() - INTERVAL '${ajustes.carenciaExpiradoDias} days'
       )
       -- teto de fila (anti-enchente)
       AND (SELECT COUNT(*) FROM receiver_queue rq2
            WHERE rq2.user_id = u.id AND rq2.status = 'pending') < ${ajustes.filaMaxima}
       -- espaçamento entre chegadas (a cota diluída no dia). A janela é dos
       -- dois lados de agora: olhar só "arrives_at > NOW() - gap" barrava por
       -- QUALQUER chegada futura, e como uma travessia leva ~5 h em média, a
       -- pessoa ficava travada por 8 h — a cota nunca seria alcançável.
       AND NOT EXISTS (
         SELECT 1 FROM receiver_queue rqg
         WHERE rqg.user_id = u.id
           AND rqg.arrives_at BETWEEN NOW() - INTERVAL '${gapMin} minutes'
                                  AND NOW() + INTERVAL '${gapMin} minutes'
       )
       -- teto do dia: o que passar disso vai para o oceano de reserva
       AND (SELECT COUNT(*) FROM receiver_queue rqd
            WHERE rqd.user_id = u.id
              AND rqd.arrives_at > NOW() - INTERVAL '24 hours') < ${ajustes.barcosPorDia}
     ORDER BY
       (SELECT COALESCE(MAX(arrives_at), TIMESTAMPTZ 'epoch')
        FROM receiver_queue WHERE user_id = u.id) ASC,
       RANDOM()
     LIMIT 1`,
    [boatId, maxIgnoresPerUser],
  );
  if (humans[0]) {
    return { id: humans[0].id, isBot: false, country: humans[0].country_code ?? null };
  }

  // FASE 2 — oceano de reserva: um bot qualquer (bots podem repetir barcos;
  // são apenas os "portos" que carimbam países aleatórios)
  const { rows: bots } = await pool.query(
    `SELECT id FROM users
     WHERE oauth_provider = 'bot' AND ban_status = 'active'
     ORDER BY RANDOM() LIMIT 1`,
  );
  return bots[0] ? { id: bots[0].id, isBot: true, country: null } : null;
}

export async function enqueueForReceiver(
  boatId: string,
  userId: string,
  opts: { travelMin: number; destCountry: string | null },
): Promise<void> {
  // o barco "navega" travelMin minutos (distância real) antes de atracar;
  // o prazo de resposta só começa a contar quando ele chega (arrives_at)
  const arrivesAt = new Date(Date.now() + opts.travelMin * 60_000);
  const { prazoRespostaHoras } = await ajustesDoFluxo();
  const expiresAt = new Date(arrivesAt.getTime() + prazoRespostaHoras * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO receiver_queue (boat_id, user_id, arrives_at, expires_at, dest_country)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [boatId, userId, arrivesAt, expiresAt, opts.destCountry],
  );
}

export async function getLastHopCountry(boatId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT country_code FROM boat_hops
     WHERE boat_id = $1
     ORDER BY hopped_at DESC
     LIMIT 1`,
    [boatId],
  );
  if (rows[0]) return rows[0].country_code;
  // sem pulos ainda: o barco parte do país de lançamento (mensagem inicial)
  const { rows: first } = await pool.query(
    `SELECT country_code FROM boat_messages
     WHERE boat_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [boatId],
  );
  return first[0]?.country_code ?? null;
}

export async function recordHop(params: {
  boatId: string;
  fromUserId: string | null;
  toUserId: string;
  countryCode: string;
  messageId: string | null;
}): Promise<void> {
  const { boatId, fromUserId, toUserId, countryCode, messageId } = params;

  // Transação de verdade: uma conexão só, do BEGIN ao COMMIT. Ver `emTransacao`
  // em db/pool.ts para o que `pool.query('BEGIN')` fazia de errado. Este é o
  // bloco em que isso mais importa: o pulo, os países e o estágio do barco são
  // a mesma informação contada de quatro formas. Meio pulo gravado é um barco
  // que esteve num país que não conta, ou um estágio que não bate com a
  // travessia — e nada disso reclama.
  await emTransacao(async (c) => {
    // Record the hop
    await c.query(
      `INSERT INTO boat_hops (boat_id, from_user_id, to_user_id, country_code, message_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [boatId, fromUserId, toUserId, countryCode, messageId],
    );

    // Deduplicated country tracking
    await c.query(
      `INSERT INTO boat_countries (boat_id, country_code)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [boatId, countryCode],
    );

    // Unique interaction per country
    if (messageId) {
      await c.query(
        `INSERT INTO boat_country_interactions (boat_id, country_code, user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [boatId, countryCode, toUserId],
      );
    }

    // Update boat stage + last_hop_at + unique_countries
    await c.query(
      `UPDATE boats
       SET
         unique_countries = (
           SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1
         ),
         stage = ${STAGE_CASE_SQL},
         last_hop_at = NOW()
       WHERE id = $1`,
      [boatId],
    );

  });
}
