import { blocklist, dadoDeContato } from './moderation.js';

/**
 * A régua de risco do painel de moderação — uma nota de 1 a 5 por mensagem.
 *
 *   1  limpa: nada na mensagem chama atenção
 *   2  sinal fraco: pede contato sem dar o dado, grita em maiúsculas, palavra leve
 *   3  palavrão comum, insulto, droga, cheiro de golpe/dinheiro
 *   4  ofensa pesada, conteúdo sexual explícito, ameaça — ou dois sinais de 3
 *   5  a moderação RECUSARIA hoje (lista de bloqueio ou dado de contato)
 *
 * Isto NÃO modera nada: não apaga, não recusa, não conta para banimento. É só
 * uma lanterna para o administrador achar, no meio de centenas de mensagens,
 * as poucas que merecem um olho humano. Por isso a lista aqui pode (e deve)
 * ser mais larga que a da moderação: um falso positivo custa um segundo de
 * leitura, não a conta de ninguém.
 *
 * Nota 5 com mensagem publicada quer dizer que ela entrou antes da regra
 * existir, ou por um caminho que não passou pela moderação — vale olhar.
 *
 * Desde 23/09/2026 a IA está sem crédito e a moderação é só a lista de bloqueio
 * (ver /health). Enquanto for assim, esta régua é o que sobra para achar o que
 * escapou.
 */

export interface Risco {
  nivel: 1 | 2 | 3 | 4 | 5;
  /** O que acendeu a nota, em palavras para o painel. Vazio quando nível 1. */
  sinais: string[];
}

// ── As listas ────────────────────────────────────────────────────────────────
//
// Sem acento e em minúsculas: o texto é normalizado do mesmo jeito antes da
// comparação. Cada termo casa como PALAVRA INTEIRA — "puta" não acende em
// "computador". Um `*` no fim aceita qualquer continuação ("fod*" pega foda,
// fodeu, fodase).
//
// Português, inglês e espanhol primeiro (é onde está quase todo mundo), e o
// grosso de francês, alemão, italiano e hindi romanizado. Termos ambíguos de
// propósito ficaram de fora — "con" (com, em espanhol), "rola" (acontece),
// "burro" (o animal) — porque acender em toda frase inocente cegaria a régua.

const PESADO = [
  // pt
  'buceta', 'caralho', 'filho da puta', 'fdp', 'vai se foder', 'vai tomar no cu',
  'tomar no cu', 'arrombad*', 'cuzao', 'puta', 'putas', 'vagabunda', 'piranha',
  'estupr*', 'vou te matar', 'te matar', 'se mata', 'pedofil*', 'boquete',
  'punheta', 'xoxota', 'nudes', 'porno', 'sexo', 'viado',
  // en
  'fuck*', 'motherfuck*', 'cunt', 'bitch*', 'whore', 'slut*', 'dick', 'cock',
  'pussy', 'rape*', 'kill you', 'kill yourself', 'nigga*', 'fag', 'faggot*',
  'tranny', 'pedophil*', 'horny', 'blowjob', 'cum', 'onlyfans',
  'porn*', 'sex', 'sexting',
  // es
  'puto', 'pendejo*', 'cabron*', 'maricon*', 'chinga*', 'hijo de puta',
  'hijueputa', 'gilipollas', 'follar', 'culero', 'te voy a matar',
  // fr
  'salope', 'connard*', 'connasse', 'encule*', 'nique ta mere', 'ntm', 'pute',
  'batard*',
  // de
  'fick*', 'fotze', 'hure', 'hurensohn', 'arschloch', 'wichser', 'schlampe',
  // it
  'cazzo', 'vaffanculo', 'stronzo', 'puttana', 'troia',
  // hi (romanizado)
  'chutiya', 'madarchod', 'bhenchod', 'behenchod', 'bhosdike', 'randi',
  // ideologia de ódio, em qualquer língua
  'nazi*', 'nazist*', 'hitler', 'heil',
];

const MEDIO = [
  // pt
  'porra', 'merda', 'bosta', 'idiota', 'imbecil', 'otari*', 'babaca', 'cacete',
  'fod*', 'desgracad*', 'corno', 'maconha', 'cocaina', 'pix', 'renda extra',
  'ganhe dinheiro', 'lucro garantido', 'investimento', 'cassino', 'apostas',
  'te odeio', 'odeio voce',
  // ambíguos demais para "pesado": também são bicho, língua ou peça de barco
  // ("verga" é a vara da vela), mas como insulto pedem um olho
  'veado', 'bicha', 'macaca', 'crioulo',
  // en
  'shit*', 'bullshit', 'bastard*', 'asshole*', 'idiot*', 'moron*', 'dumbass',
  'hate you', 'weed', 'cocaine', 'heroin', 'meth', 'cashapp', 'cash app',
  'bitcoin', 'crypto', 'investment', 'earn money', 'make money', 'casino',
  'send money', 'paypal', 'venmo',
  // es
  'mierda', 'joder', 'estupid*', 'cabrona', 'cono', 'verga', 'polla', 'zorra',
  // fr
  'merde', 'putain', 'bordel',
  // de
  'scheisse', 'scheiss*', 'arsch', 'idioten',
  // it
  'merda', 'cretino',
];

const LEVE = [
  // pedir contato sem dar o dado — a moderação só recusa o dado em si
  'whatsapp', 'zap', 'zapzap', 'insta', 'instagram', 'telegram',
  'discord', 'snapchat', 'snap', 'tiktok', 'facebook', 'twitter', 'kik',
  'me chama', 'me add', 'me adiciona', 'me segue', 'add me', 'follow me',
  'dm me', 'text me', 'call me', 'my number', 'meu numero', 'mi numero',
  // palavras leves
  'droga', 'stupid', 'damn', 'crap', 'sexy', 'baka', 'drogas',
];

// Línguas sem espaço entre palavras: casam como trecho, não como palavra.
const PESADO_SEM_ESPACO = ['死ね', '殺す', 'セックス', 'ちんこ', 'まんこ', 'レイプ'];
const LEVE_SEM_ESPACO = ['バカ', 'ばか', 'クソ'];

// ── Normalização ─────────────────────────────────────────────────────────────

/** Minúsculas, sem acento, com o "leet" mais comum desfeito (f0d4 → foda). */
function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
    .replace(/4/g, 'a').replace(/5/g, 's').replace(/\$/g, 's').replace(/@/g, 'a')
    // letra soletrada com separador: "p.u.t.a", "m-e-r-d-a" (mas não "bem-vindo")
    .replace(/(?:\p{L}[_*.\-]){2,}\p{L}/gu, (m) => m.replace(/[_*.\-]/g, ''))
    .replace(/\s+/g, ' ');
}

/** "puuuuta" → "puta". Só para comparar termos de 4+ letras (ver `compilar`). */
function semRepeticao(s: string): string {
  return s.replace(/(\p{L})\1+/gu, '$1');
}

interface Termo { rotulo: string; re: RegExp; reCurto: RegExp | null }
interface Lista { termos: Termo[]; peneira: RegExp; peneiraCurta: RegExp | null }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
const palavra = (miolo: string) =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${miolo})(?=$|[^\\p{L}\\p{N}])`, 'u');

function compilar(lista: string[]): Lista {
  const termos = lista.map((t) => {
    const prefixo = t.endsWith('*');
    const base = prefixo ? t.slice(0, -1) : t;
    const fim = prefixo ? '\\p{L}*' : '';
    const re = palavra(esc(base) + fim);
    // Letra esticada ("fuuuuck") só é testada em termo que, sem repetição,
    // continua com 4+ letras: "ass" viraria "as" e acenderia no artigo.
    const curto = semRepeticao(base);
    const mioloCurto = curto.replace(/ /g, '').length < 4 ? null : esc(curto) + fim;
    const reCurto = !mioloCurto ? null : curto === base ? re : palavra(mioloCurto);
    return { rotulo: base, re, reCurto, miolo: esc(base) + fim, mioloCurto };
  });
  // A peneira: a lista inteira numa expressão só. Quase toda mensagem é limpa
  // e para nela; o termo a termo (que dá o nome do que acendeu) só roda
  // quando ela acusa algo. Sem isto, pontuar as ~19 mil mensagens do banco
  // levava 2,5 s.
  const curtos = termos.map((t) => t.mioloCurto).filter(Boolean);
  return {
    termos: termos.map(({ rotulo, re, reCurto }) => ({ rotulo, re, reCurto })),
    peneira: palavra(termos.map((t) => t.miolo).join('|')),
    peneiraCurta: curtos.length ? palavra(curtos.join('|')) : null,
  };
}

const T_PESADO = compilar(PESADO);
const T_MEDIO  = compilar(MEDIO);
const T_LEVE   = compilar(LEVE);

function achados(lista: Lista, texto: string, textoSemRep: string): string[] {
  if (!lista.peneira.test(texto) && !(lista.peneiraCurta && lista.peneiraCurta.test(textoSemRep))) {
    return [];
  }
  const out: string[] = [];
  for (const t of lista.termos) {
    if (t.re.test(texto) || (t.reCurto && t.reCurto.test(textoSemRep))) out.push(t.rotulo);
  }
  return out;
}

// ── A nota ───────────────────────────────────────────────────────────────────

export function avaliarRisco(conteudo: string | null | undefined): Risco {
  const bruto = conteudo ?? '';
  if (!bruto.trim()) return { nivel: 1, sinais: [] };

  // 5 — as mesmas regras que recusam uma mensagem hoje, no texto original
  // (o e-mail precisa do @ que a normalização transforma em "a").
  if (blocklist(bruto)) return { nivel: 5, sinais: ['lista de bloqueio da moderação'] };
  const contato = dadoDeContato(bruto);
  if (contato) return { nivel: 5, sinais: [`dado de contato (${contato})`] };

  const texto = normalizar(bruto);
  const semRep = semRepeticao(texto);

  const pesados = [
    ...achados(T_PESADO, texto, semRep),
    ...PESADO_SEM_ESPACO.filter((p) => bruto.includes(p)),
  ];
  const medios = achados(T_MEDIO, texto, semRep);
  const leves = [
    ...achados(T_LEVE, texto, semRep),
    ...LEVE_SEM_ESPACO.filter((p) => bruto.includes(p)),
  ];

  // @fulano — um usuário de rede social sem o nome da rede
  if (/(^|\s)@[a-z0-9_.]{3,}/i.test(bruto)) leves.push('@usuário');

  // Gritando: muitas letras e quase todas maiúsculas
  const letras = bruto.match(/\p{L}/gu) ?? [];
  const maiusculas = bruto.match(/\p{Lu}/gu) ?? [];
  if (letras.length >= 12 && maiusculas.length / letras.length > 0.7) leves.push('TUDO EM MAIÚSCULAS');

  // Mesma letra ou !/? 6+ vezes seguidas. O "k" fica de fora: "kkkkkk" é
  // risada no Brasil, não grito.
  if (/([\p{L}!?])\1{5,}/u.test(bruto.replace(/k/gi, ''))) leves.push('caractere repetido');

  // Uma palavra acende um sinal só. "merda" está no português e no italiano;
  // "idiota" casa com "idiota" e com "idiot*"; "vai se foder" contém "fod*".
  // Sem isto, um único palavrão contaria como dois e pularia de 3 para 4.
  const vistos: string[] = [];
  const unico = (lista: string[]) => lista.filter((x) => {
    if (vistos.some((v) => v.includes(x) || x.includes(v))) return false;
    vistos.push(x);
    return true;
  });
  pesados.splice(0, pesados.length, ...unico(pesados));
  medios.splice(0, medios.length, ...unico(medios));
  leves.splice(0, leves.length, ...unico(leves));

  const sinais = [
    ...pesados.map((p) => `pesado: ${p}`),
    ...medios.map((m) => `palavrão/risco: ${m}`),
    ...leves.map((l) => `leve: ${l}`),
  ];

  let nivel: Risco['nivel'] = 1;
  if (pesados.length) nivel = 4;
  else if (medios.length >= 2) nivel = 4;
  else if (medios.length === 1) nivel = 3;
  else if (leves.length >= 3) nivel = 3;
  else if (leves.length) nivel = 2;

  return { nivel, sinais };
}
