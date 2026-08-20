#!/usr/bin/env node
/**
 * As duas metades do ciclo de tradução do Adrift.
 *
 *   node scripts/traducoes.mjs extrair    varre o código e atualiza o CSV,
 *                                         PRESERVANDO o que já foi traduzido
 *   node scripts/traducoes.mjs compilar   lê o CSV e gera os JSON que o app e
 *                                         o servidor carregam
 *
 * O CSV é o formato de trabalho de propósito: quem traduz abre numa planilha,
 * não num editor de código. `pt` é a primeira coluna E a chave de busca — ver
 * a explicação inteira em mobile/services/i18n.ts.
 *
 * `extrair` nunca sobrescreve tradução. Ele mescla: mantém as linhas que já
 * existem, acrescenta as novas e MARCA as órfãs (texto que sumiu do código)
 * em vez de apagar — apagar seria jogar fora trabalho de tradução por causa de
 * uma vírgula mudada no português.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Este arquivo mora em backend/scripts/, mas trabalha nas DUAS pontas — sobe
// dois níveis para chegar em adrift/. Fica dentro do repositório do backend
// porque é o único que vai para o GitHub: fora dele, a ferramenta existiria só
// no disco.
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSV = join(RAIZ, '..', 'adrift-textos-para-traduzir.csv');

// Fora da varredura, e cada um por um motivo:
//   countries/country-data  Intl.DisplayNames dá os 195 nomes de graça
//   terms                   texto jurídico, decisão à parte
//   bots                    os bots já escrevem no idioma do país deles
const PULAR_ARQUIVO = ['countries.ts', 'country-data.ts', 'terms.ts', 'bots.ts', 'i18n.ts'];
const PULAR_DIR = ['node_modules', '.git', 'dist', '.expo', 'backups', 'admin', 'db', 'scripts', 'locales'];

const ACENTO = /[à-üÀ-Ü]/;
const PALAVRAS = /\b(de|para|que|com|em|seu|sua|voce|nao|uma|do|da|no|na|os|as|ao)\b/gi;
const LITERAL = /(['"`])([^'"`\n]{5,300})\1/g;
const LOG = /console\.(log|warn|error)|\[(mail|aviso|alerta|moderation|routing|journey|sweep|push|conduta|admin|defesas|captcha|verificacao|boas-vindas|remoderar|traduzir|scheduler|server|webpush|i18n)\]/;
const IGNORAR = ['http', './', '../', '#', '@', 'data:', 'rgba', 'rgb(', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'];

/**
 * Texto que NUNCA chega a um usuário, e que por isso não deve ir para o CSV.
 *
 * Dez frases assim escaparam na primeira extração e foram traduzidas para sete
 * idiomas sem necessidade nenhuma: moldura de log, comentário dentro de SQL,
 * exemplo dentro de um prompt de IA, código de erro que só o painel vê.
 * Traduzir é barato; o custo real é o CSV encher de linha que não importa e
 * esconder as que importam.
 */
const NAO_E_DE_USUARIO = [
  /^┌|^│|^└|^├/,          // molduras de log (┌ │ └ ├)
  /^← /,                                  // seta de aviso no log (←)
  /log dizendo|verdict|rejected\/uncertain/i,  // comentário dentro de SQL
  /aspas\/espa|chave aceita|\(padr[ãa]o\)/i,   // diagnóstico do /health
  /^(ban_status|role|status|key e value) /i,   // erro de API só do painel
];

/**
 * Transforma as sequências de escape do CÓDIGO nos caracteres de verdade.
 *
 * No arquivo, `'linha um\nlinha dois'` são os caracteres barra-invertida e n.
 * Em execução o JavaScript já os transformou numa quebra de linha — e é ESSA
 * a chave que `t()` procura. Sem esta conversão, o CSV guardaria 38 caracteres
 * onde o app procura 37, e a tradução nunca seria encontrada: o app mostraria o
 * português para sempre, sem erro nenhum aparecendo.
 *
 * Uma passada só, da esquerda para a direita. Fazer com `replace` em sequência
 * quebraria `\\n` — a barra escapada seguida de n viraria quebra de linha.
 */
function desescapar(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { out += s[i]; continue; }
    const p = s[++i];
    out += p === 'n' ? '\n'
      : p === 't' ? '\t'
      : p === 'r' ? '\r'
      : p === undefined ? '\\'
      : p;                      // \' \" \` \\ viram o próprio caractere
  }
  return out;
}

function ehTexto(t, linha) {
  const s = t.trim();
  if (s.length < 5) return false;
  if (IGNORAR.some((p) => s.startsWith(p))) return false;
  if (/^[A-Za-z0-9_\-.:/ ]+$/.test(s)) return false;
  if (LOG.test(linha)) return false;
  if (NAO_E_DE_USUARIO.some((re) => re.test(s))) return false;
  return ACENTO.test(s) || (s.match(PALAVRAS) ?? []).length >= 2;
}

function* arquivos(dir) {
  for (const nome of readdirSync(dir)) {
    if (PULAR_DIR.includes(nome)) continue;
    const p = join(dir, nome);
    if (statSync(p).isDirectory()) { yield* arquivos(p); continue; }
    if (!/\.tsx?$/.test(nome) || PULAR_ARQUIVO.includes(nome)) continue;
    yield p;
  }
}

function varrer() {
  const achados = new Map();   // texto -> "arquivo:linha"
  for (const base of [join(RAIZ, 'mobile'), join(RAIZ, 'backend', 'src')]) {
    if (!existsSync(base)) continue;
    for (const p of arquivos(base)) {
      const rel = relative(RAIZ, p).replace(/\\/g, '/');
      const linhas = readFileSync(p, 'utf8').split('\n');
      linhas.forEach((linha, i) => {
        const s = linha.trim();
        if (s.startsWith('*') || s.startsWith('//') || s.startsWith('/*')) return;
        for (const m of linha.matchAll(LITERAL)) {
          const bruto = m[2].trim();
          if (!ehTexto(bruto, linha)) continue;
          // A chave tem de ser o texto COMO ELE EXISTE EM EXECUÇÃO.
          const t = desescapar(bruto);
          if (!achados.has(t)) achados.set(t, `${rel}:${i + 1}`);
        }
      });
    }
  }
  return achados;
}

// ── CSV mínimo, sem dependência ─────────────────────────────────────────────

/**
 * O símbolo que ocupa o lugar de uma quebra de linha no CSV.
 *
 * A coluna `pt` tem de bater EXATAMENTE com o texto em execução, senão a busca
 * falha — foi o defeito de 19/08. Mas quebra de verdade parte a frase em duas
 * linhas da planilha, e quem traduz não deve ter de lidar com isso.
 *
 * Um símbolo resolve os dois lados: cada texto ocupa UMA linha, e a chave
 * continua reconstruível na volta. Escolhi ⏎ por ser visível e não aparecer em
 * texto de verdade — ao contrário de `\n`, que numa frase como "vai\nno
 * coração" parece um símbolo esquisito em vez de uma quebra.
 *
 * Quem traduz pode ignorá-lo e escrever a frase corrida: as quebras de cada
 * idioma são reinseridas depois, onde fizerem sentido naquele idioma.
 */
const QUEBRA = '⏎';

/**
 * Sempre entre aspas.
 *
 * O CSV só EXIGE aspas quando o campo tem vírgula, aspas ou quebra — e aí
 * metade das linhas sai citada e metade não, o que parece inconsistência ao
 * abrir o arquivo cru. Citar tudo é igualmente válido e some com a estranheza.
 */
function csvEscapar(v) {
  return `"${String(v ?? '').split('"').join('""')}"`;
}

function csvLer(txt) {
  const linhas = [];
  let campo = '', linha = [], dentro = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (dentro) {
      if (c === '"' && txt[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') dentro = false;
      else campo += c;
    } else if (c === '"') dentro = true;
    else if (c === ',') { linha.push(campo); campo = ''; }
    else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas.filter((l) => l.some((c) => c !== ''));
}

function extrair() {
  const achados = varrer();

  let cabecalho = ['pt', 'en', 'es', 'arquivo', 'situacao'];
  const existentes = new Map();
  if (existsSync(CSV)) {
    const linhas = csvLer(readFileSync(CSV, 'utf8').replace(/^﻿/, ''));
    cabecalho = linhas[0];
    const iPt = cabecalho.indexOf('pt');
    for (const l of linhas.slice(1)) {
      const obj = {};
      cabecalho.forEach((c, i) => { obj[c] = String(l[i] ?? '').split(QUEBRA).join('\n'); });
      if (obj[iPt >= 0 ? 'pt' : cabecalho[0]]) existentes.set(obj.pt, obj);
    }
  }

  let novos = 0, orfaos = 0;
  const saida = [];

  for (const [texto, onde] of achados) {
    const antigo = existentes.get(texto);
    if (antigo) {
      saida.push({ ...antigo, arquivo: onde, situacao: '' });
    } else {
      const linha = {};
      cabecalho.forEach((c) => { linha[c] = ''; });
      linha.pt = texto; linha.arquivo = onde; linha.situacao = 'NOVO';
      saida.push(linha);
      novos++;
    }
  }
  // Órfãos ficam no fim, MARCADOS e não apagados: a tradução deles custou
  // trabalho e o texto pode ter só mudado de vírgula.
  for (const [texto, linha] of existentes) {
    if (!achados.has(texto)) {
      saida.push({ ...linha, situacao: 'ORFAO — sumiu do codigo' });
      orfaos++;
    }
  }

  if (!cabecalho.includes('situacao')) cabecalho.push('situacao');
  // Quebra de linha vira símbolo na saída: cada texto ocupa UMA linha da
  // planilha, e a chave continua reconstruível na volta.
  const paraCsv = (v) => String(v ?? '').split('\n').join(QUEBRA);
  const txt = [cabecalho.map(csvEscapar).join(',')]
    .concat(saida.map((l) => cabecalho.map((c) => csvEscapar(paraCsv(l[c]))).join(',')))
    .join('\n');
  writeFileSync(CSV, '﻿' + txt, 'utf8');

  console.log(`${achados.size} textos no codigo`);
  console.log(`  ${novos} novos`);
  console.log(`  ${orfaos} orfaos (marcados, nao apagados)`);
  console.log(`CSV: ${CSV}`);
}

function compilar() {
  if (!existsSync(CSV)) { console.error(`CSV nao encontrado: ${CSV}`); process.exit(1); }
  const linhas = csvLer(readFileSync(CSV, 'utf8').replace(/^﻿/, ''));
  const cabecalho = linhas[0];
  const idiomas = cabecalho.filter((c) => !['pt', 'arquivo', 'situacao', 'chave'].includes(c));

  const dic = {};
  idiomas.forEach((l) => { dic[l] = {}; });
  let traduzidos = 0;

  for (const l of linhas.slice(1)) {
    const obj = {};
    cabecalho.forEach((c, i) => { obj[c] = String(l[i] ?? '').split(QUEBRA).join('\n'); });
    if (!obj.pt || String(obj.situacao).startsWith('ORFAO')) continue;
    for (const idioma of idiomas) {
      const v = String(obj[idioma] ?? '').trim();
      // Vazio NÃO vira entrada: sem entrada, t() devolve o português, que é
      // melhor do que devolver string vazia e deixar um buraco na tela.
      if (v) { dic[idioma][obj.pt] = v; traduzidos++; }
    }
  }

  for (const destino of [join(RAIZ, 'mobile', 'locales'), join(RAIZ, 'backend', 'src', 'locales')]) {
    mkdirSync(destino, { recursive: true });
    for (const idioma of idiomas) {
      writeFileSync(join(destino, `${idioma}.json`), JSON.stringify(dic[idioma], null, 2) + '\n', 'utf8');
    }
  }

  console.log(`idiomas: ${idiomas.join(', ')}`);
  for (const l of idiomas) {
    const n = Object.keys(dic[l]).length;
    console.log(`  ${l}: ${n} traduzidos`);
  }
  console.log(`${traduzidos} entradas gravadas em mobile/locales e backend/src/locales`);
}

const cmd = process.argv[2];
if (cmd === 'extrair') extrair();
else if (cmd === 'compilar') compilar();
else {
  console.log('uso: node scripts/traducoes.mjs extrair|compilar');
  process.exit(1);
}
