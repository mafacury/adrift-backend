/**
 * Horizonte — os barcos que estão MESMO no mar agora.
 *
 * Toda linha pendente da receiver_queue é uma travessia em andamento: saiu do
 * último porto (o hop anterior) rumo ao país de quem vai receber, e leva o
 * tempo que a distância real pede (ver services/routing.ts). Então dá para
 * dizer, a qualquer instante, onde cada barco está sobre o globo: interpola-se
 * a posição no grande círculo entre origem e destino pela fração do tempo já
 * navegada. Daí saem a distância até quem está olhando e a marcação (rumo).
 *
 * PRIVACIDADE: sai daqui apenas distância e marcação. Nunca o país de origem
 * ou destino, nunca de quem é o barco, nunca um id — não há o que correlacionar
 * entre duas consultas.
 *
 * O cálculo pesado (posição de cada travessia) não depende de quem pergunta,
 * então fica em cache por alguns segundos e serve a todo mundo; só a distância
 * e o rumo são por observador.
 */
import { pool } from '../db/pool.js';

/** Alcance do avistamento, em milhas náuticas — o limite da vista. */
export const RANGE_NM = 10000;
/** Daqui para dentro o barco não é mais paisagem: está atracando. */
export const DOCK_NM = 10;

/**
 * Quanto de horizonte cabe na largura da tela. 340° e não 360 porque o pedaço
 * que sobra fica às costas de quem olha: é lá que o barco que deu a volta
 * "salta" de uma borda para a outra, e ninguém vê o salto acontecer.
 */
export const PANORAMA_DEG = 340;

const MAX_SIGHTINGS = 8;       // quantos barcos o horizonte comporta sem virar sopa
const MIN_SEP_DEG   = 25;      // separação mínima entre avistamentos (ver escolha abaixo)
const CACHE_MS      = 12_000;  // idade máxima da lista de travessias
const MAX_LEGS      = 400;     // teto de travessias consideradas por varredura
const KM_PER_NM     = 1.852;
const RAD           = Math.PI / 180;
const LOOKAHEAD_MIN = 1;       // janela usada para medir a velocidade aparente

interface Leg {
  userId: string;
  oLat: number; oLon: number;
  dLat: number; dLon: number;
  startedMs: number;
  arrivesMs: number;
  /** Modelo do barco (1 a 8) — é o que a tela desenha no horizonte. */
  stage: number;
}

let cache: { at: number; legs: Leg[] } | null = null;

/**
 * Travessias em andamento. Uma linha por barco no mar: origem = último porto
 * antes da partida (ou o país onde ele foi lançado), destino = país de quem
 * espera (bots trazem o destino sorteado na própria linha).
 */
async function inFlightLegs(): Promise<Leg[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.legs;

  const { rows } = await pool.query(
    `SELECT
       rq.user_id,
       b.stage,
       EXTRACT(EPOCH FROM rq.queued_at)  * 1000 AS started_ms,
       EXTRACT(EPOCH FROM rq.arrives_at) * 1000 AS arrives_ms,
       COALESCE(oh.lat, om.lat) AS o_lat,
       COALESCE(oh.lon, om.lon) AS o_lon,
       d.lat AS d_lat,
       d.lon AS d_lon
     FROM receiver_queue rq
     JOIN users ru ON ru.id = rq.user_id
     JOIN boats b  ON b.id  = rq.boat_id
     LEFT JOIN countries d ON d.code = COALESCE(rq.dest_country, ru.country_code)
     -- porto de partida: o último pulo antes de zarpar
     LEFT JOIN LATERAL (
       SELECT c.lat, c.lon
       FROM boat_hops h JOIN countries c ON c.code = h.country_code
       WHERE h.boat_id = rq.boat_id AND h.hopped_at <= rq.queued_at
       ORDER BY h.hopped_at DESC LIMIT 1
     ) oh ON TRUE
     -- barco que ainda não pulou: parte de onde foi lançado
     LEFT JOIN LATERAL (
       SELECT c.lat, c.lon
       FROM boat_messages m JOIN countries c ON c.code = m.country_code
       WHERE m.boat_id = rq.boat_id
       ORDER BY m.created_at ASC LIMIT 1
     ) om ON TRUE
     WHERE rq.status = 'pending'
       AND rq.arrives_at > NOW()
       AND rq.expires_at > NOW()
     ORDER BY rq.arrives_at ASC
     LIMIT ${MAX_LEGS}`,
  );

  const legs: Leg[] = rows
    .filter(r => r.o_lat != null && r.d_lat != null)
    .map(r => ({
      userId:    r.user_id,
      oLat:      Number(r.o_lat),  oLon: Number(r.o_lon),
      dLat:      Number(r.d_lat),  dLon: Number(r.d_lon),
      startedMs: Number(r.started_ms),
      arrivesMs: Number(r.arrives_ms),
      stage:     Number(r.stage) || 1,
    }));

  cache = { at: Date.now(), legs };
  return legs;
}

/**
 * Ponto a `f` (0..1) do caminho de A para B sobre o grande círculo — a rota
 * que um navio realmente faz, não a reta do mapa plano. Usado pelo horizonte e
 * pela perna em andamento que o mapa desenha (ver routes/boats.ts).
 */
export function greatCirclePoint(
  aLat: number, aLon: number, bLat: number, bLon: number, f: number,
): { lat: number; lon: number } {
  const φ1 = aLat * RAD, λ1 = aLon * RAD;
  const φ2 = bLat * RAD, λ2 = bLon * RAD;

  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((φ2 - φ1) / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2,
  ));
  if (d < 1e-9) return { lat: bLat, lon: bLon };

  const a = Math.sin((1 - f) * d) / Math.sin(d);
  const b = Math.sin(f * d) / Math.sin(d);
  const x = a * Math.cos(φ1) * Math.cos(λ1) + b * Math.cos(φ2) * Math.cos(λ2);
  const y = a * Math.cos(φ1) * Math.sin(λ1) + b * Math.cos(φ2) * Math.sin(λ2);
  const z = a * Math.sin(φ1) + b * Math.sin(φ2);

  return {
    lat: Math.atan2(z, Math.hypot(x, y)) / RAD,
    lon: Math.atan2(y, x) / RAD,
  };
}

/** Fração da travessia já navegada, pelo relógio. */
export function legProgress(startedMs: number, arrivesMs: number, atMs: number): number {
  const total = Math.max(arrivesMs - startedMs, 1);
  return Math.min(Math.max((atMs - startedMs) / total, 0), 1);
}

/** Onde a travessia está no instante `atMs`. */
function positionAt(leg: Leg, atMs: number): { lat: number; lon: number } {
  return greatCirclePoint(
    leg.oLat, leg.oLon, leg.dLat, leg.dLon,
    legProgress(leg.startedMs, leg.arrivesMs, atMs),
  );
}

function nauticalMiles(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dφ = (bLat - aLat) * RAD, dλ = (bLon - aLon) * RAD;
  const h = Math.sin(dφ / 2) ** 2 +
    Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dλ / 2) ** 2;
  return (2 * 6371 * Math.asin(Math.sqrt(h))) / KM_PER_NM;
}

/** Rumo de A para B, em graus de bússola (0 = norte). */
function bearing(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const φ1 = aLat * RAD, φ2 = bLat * RAD, dλ = (bLon - aLon) * RAD;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/**
 * Para onde a tela olha, em graus de bússola — a média circular dos rumos
 * daqui para todos os países ativos. Ou seja: a direção em que está o resto do
 * mundo, vista deste ponto.
 *
 * Não é o norte de propósito. Com o norte no centro o panorama fica torto para
 * quase todo mundo, porque a metade vazia da tela é o lado de TERRA: do Brasil
 * o tráfego todo cai à direita (x médio 0,59), do Japão à esquerda (0,41), da
 * Islândia à direita (0,67). Girando, todos ficam perto de 0,50.
 *
 * Girar não custa honestidade: não há bússola nessa tela, então ninguém pode
 * perceber onde fica o norte, e a ordem relativa continua verdadeira — mais à
 * direita ainda é mais no sentido horário.
 */
const PLACES_CACHE_MS = 10 * 60_000;
let places: { at: number; rows: { lat: number; lon: number }[] } | null = null;

async function activePlaces() {
  if (places && Date.now() - places.at < PLACES_CACHE_MS) return places.rows;
  const { rows } = await pool.query(
    `SELECT lat, lon FROM countries WHERE active AND lat IS NOT NULL`,
  );
  places = { at: Date.now(), rows: rows.map(r => ({ lat: Number(r.lat), lon: Number(r.lon) })) };
  return places.rows;
}

async function facingFrom(lat: number, lon: number): Promise<number> {
  let sx = 0, sy = 0;
  for (const p of await activePlaces()) {
    // o próprio país não aponta para lugar nenhum
    if (Math.abs(p.lat - lat) < 0.01 && Math.abs(p.lon - lon) < 0.01) continue;
    const b = bearing(lat, lon, p.lat, p.lon) * RAD;
    sx += Math.cos(b); sy += Math.sin(b);
  }
  return sx === 0 && sy === 0 ? 0 : (Math.atan2(sy, sx) / RAD + 360) % 360;
}

/** Diferença de rumo no caminho curto: −180..180. */
function turn(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

export interface Sighting {
  /**
   * Modelo do barco, de 1 a 8.
   *
   * É a única coisa que sai daqui além de distância e marcação, e sai porque
   * muda a tela: ver uma Nau Lendária cruzando o horizonte é diferente de ver
   * uma Novata. Não identifica ninguém — é uma faixa larga, derivada de quantas
   * mensagens aquele barco juntou, e não se liga a pessoa, país ou id.
   */
  stage: number;
  /** Distância agora, em milhas náuticas. */
  nm: number;
  /** Quanto essa distância muda por minuto (negativo = vindo para cá). */
  nmPerMin: number;
  /**
   * Marcação JÁ RELATIVA ao centro do panorama, de −180 a 180 — é o ângulo
   * que a tela usa direto para achar o x. O centro não é o norte (ver
   * facingFrom), e o valor de bússola cru não sai daqui porque a tela não
   * teria o que fazer com ele.
   */
  bearing: number;
  /** Quanto a marcação anda por minuto — o barco cruzando o horizonte. */
  bearingPerMin: number;
}

function sight(leg: Leg, lat: number, lon: number, atMs: number, center: number): Sighting {
  const now  = positionAt(leg, atMs);
  const soon = positionAt(leg, atMs + LOOKAHEAD_MIN * 60_000);
  const nm   = nauticalMiles(lat, lon, now.lat,  now.lon);
  const nm2  = nauticalMiles(lat, lon, soon.lat, soon.lon);
  const br   = bearing(lat, lon, now.lat,  now.lon);
  const br2  = bearing(lat, lon, soon.lat, soon.lon);
  return {
    stage:         leg.stage,
    nm:            Math.round(nm),
    nmPerMin:      Math.round((nm2 - nm) / LOOKAHEAD_MIN * 10) / 10,
    // já girada para o centro da tela; a velocidade angular não muda com o giro
    bearing:       Math.round(relative(br - center) * 10) / 10,
    bearingPerMin: Math.round(turn(br, br2) / LOOKAHEAD_MIN * 100) / 100,
  };
}

export interface HorizonView {
  /** Instante do servidor a que os números se referem. */
  at: number;
  rangeNm: number;
  panoramaDeg: number;
  /** Rumo de bússola para onde o centro da tela aponta (ver facingFrom). */
  panoramaCenterDeg: number;
  /** Barcos alheios à vista, do mais longe para o mais perto. */
  boats: Sighting[];
  /** O barco que vem para quem perguntou (se houver um a caminho). */
  mine: (Sighting & { secondsUntil: number }) | null;
}

/** Marcação em −180..180, com 0 = norte. */
const relative = (deg: number) => ((deg + 540) % 360) - 180;

/**
 * O horizonte comporta poucos barcos: escolhe os MAIS PRÓXIMOS que ainda
 * caibam sem se empilhar. Sem isso, num corredor movimentado (do Brasil, o
 * Atlântico norte tem dezenas de travessias ao mesmo tempo) meia dúzia de
 * etiquetas cairia no mesmo ponto da tela e nenhuma seria legível.
 */
function spaced(all: Sighting[]): Sighting[] {
  const kept: Sighting[] = [];
  for (const s of [...all].sort((a, b) => a.nm - b.nm)) {
    if (kept.length >= MAX_SIGHTINGS) break;
    if (kept.every(k => Math.abs(relative(s.bearing - k.bearing)) >= MIN_SEP_DEG)) kept.push(s);
  }
  return kept;
}

/**
 * O que este usuário vê do próprio convés. Sem país no cadastro não há de onde
 * olhar — o horizonte volta vazio em vez de inventar uma origem.
 */
export async function horizonFor(userId: string): Promise<HorizonView> {
  const at = Date.now();

  const { rows: me } = await pool.query(
    `SELECT c.lat, c.lon
     FROM users u JOIN countries c ON c.code = u.country_code
     WHERE u.id = $1`,
    [userId],
  );
  if (me[0]?.lat == null) {
    return {
      at, rangeNm: RANGE_NM, panoramaDeg: PANORAMA_DEG,
      panoramaCenterDeg: 0, boats: [], mine: null,
    };
  }

  const lat = Number(me[0].lat), lon = Number(me[0].lon);
  const center = await facingFrom(lat, lon);   // para onde a tela olha daqui
  const legs = await inFlightLegs();

  // o barco que vem para mim tem tratamento próprio na tela: sai da paisagem
  const mineLeg = legs
    .filter(l => l.userId === userId)
    .sort((a, b) => a.arrivesMs - b.arrivesMs)[0];

  const boats = spaced(
    legs
      .filter(l => l.userId !== userId)
      .map(l => sight(l, lat, lon, at, center))
      .filter(s => s.nm <= RANGE_NM && Math.abs(relative(s.bearing)) <= PANORAMA_DEG / 2),
  )
    // o mais longe primeiro: é a ordem em que a tela pinta, quem está na
    // frente tapa quem está atrás
    .sort((a, b) => b.nm - a.nm);

  return {
    at,
    rangeNm: RANGE_NM,
    panoramaDeg: PANORAMA_DEG,
    // só informativo: a tela usa as marcações já giradas
    panoramaCenterDeg: Math.round(center),
    boats,
    mine: mineLeg
      ? {
          ...sight(mineLeg, lat, lon, at, center),
          secondsUntil: Math.max(0, Math.round((mineLeg.arrivesMs - at) / 1000)),
        }
      : null,
  };
}
