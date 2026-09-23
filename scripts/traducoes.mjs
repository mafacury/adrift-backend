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
  // Crase com `${}` dentro é montada em execução: a chave gravada aqui nunca
  // seria encontrada por t(), e a linha só ocuparia lugar na planilha de quem
  // traduz. (Três dessas entraram em 23/09/2026, vindas de mail.ts.)
  if (s.includes('${')) return false;
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

/**
 * Texto solto DENTRO de JSX — `<Text>Já tenho conta</Text>`.
 *
 * A primeira versão só olhava literal entre aspas e perdeu 55 frases, quase um
 * quarto do total. Numa tela React metade do texto não está entre aspas: está
 * como filho de elemento. Sem isto, a tela traduz pela metade — e o pior é que
 * o que falta some em silêncio, sem erro nenhum.
 *
 * Casa só o que está entre `>` e `<` sem chaves nem tags no meio: com `{}` o
 * conteúdo é expressão, e expressão já passa pelo caminho dos literais.
 */
// O mínimo é DOIS caracteres, não quatro: `<Text>mn</Text>` — a unidade de
// milha náutica no horizonte — é um rótulo traduzido de duas letras, e ficava
// de fora. No caminho normal isto não muda nada (`ehTexto` continua exigindo
// cinco); muda no caminho de "isto ainda está escrito?", que é onde importa.
const TEXTO_JSX = /> *([^<>{}\n][^<>{}\n]{1,199}?) *</g;

/**
 * ── O caminho que NÃO adivinha ───────────────────────────────────────────────
 *
 * `ehTexto` decide pelo português: tem acento, ou tem duas palavrinhas da
 * lista. É um chute, e chute erra dos dois lados. Errou feio para menos: em
 * 23/09/2026, de 617 linhas do CSV ele reconhecia 316 — "Entrar", "Criar
 * conta", "bloquear", "AO VIVO" não têm acento nem "de/para/que", então sumiam.
 * E `compilar` PULA linha órfã: uma rodada de `extrair` teria apagado 283
 * traduções vivas dos locales, em sete idiomas, sem erro nenhum aparecer.
 *
 * O conserto é parar de adivinhar. Quando alguém escreve `t('...')` já disse
 * que aquilo é texto de tela — a informação estava ali o tempo todo, do lado.
 * Estas duas expressões leem a chamada em vez do idioma:
 *
 *   t('texto')            no app        — o texto é o 1º argumento
 *   tr(idioma, 'texto')   no servidor   — é o 2º
 *
 * Rodam sobre o arquivo INTEIRO, e não linha a linha, porque chamada quebrada
 * em várias linhas é comum e era invisível para a varredura de antes.
 *
 * O caminho antigo continua vivo ao lado deste: catálogos como
 * `constants/agradecimentos.ts` guardam a frase numa constante e só depois a
 * passam para `t(f.texto)` — ali não há literal dentro da chamada, e é o
 * palpite do português que salva.
 */
const CHAMADA_T  = /\bt\(\s*(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g;
const CHAMADA_TR = /\btr\(\s*[^,'"`()]+?,\s*(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g;

/**
 * O mesmo arquivo com todo comentário apagado — e só ele, para as linhas
 * continuarem batendo.
 *
 * A varredura de antes pulava a linha que COMEÇA com `//` ou `*`. Lendo o
 * arquivo inteiro de uma vez esse cuidado se perde, e um `t('exemplo')` dentro
 * de um comentário explicativo viraria linha no CSV.
 */
function semComentarios(txt) {
  return txt
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => (/^\s*(\/\/|\*)/.test(l) ? '' : l))
    .join('\n');
}

/** Em que linha do arquivo cai este índice — só para o CSV dizer onde achou. */
function linhaDoIndice(txt, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < txt.length; i++) if (txt[i] === '\n') n++;
  return n;
}

/**
 * Texto que veio de dentro de uma chamada de tradução.
 *
 * Aqui não se pergunta se PARECE português: já foi marcado por quem escreveu.
 * Sobra descartar o que não é chave utilizável — crase com `${}` dentro é
 * montada em execução, e a chave gravada nunca seria encontrada.
 */
function ehTextoDeChamada(s) {
  if (!s || s.includes('${')) return false;
  if (NAO_E_DE_USUARIO.some((re) => re.test(s))) return false;
  return true;
}

/**
 * ── Por que existe uma segunda lista, a de "presentes" ───────────────────────
 *
 * Reconhecer texto de tela é um problema sem fim: `t('bloquear')` é fácil, mas
 * `Baú` guardado num catálogo e passado adiante como `t(item.label)`, ou
 * `<Text>Agradecer</Text>` solto no JSX, dependem de palpite — e palpite erra.
 *
 * Só que para NÃO ESTRAGAR nada a ferramenta não precisa acertar quem é texto
 * de tela. Precisa apenas nunca declarar MORTO o que continua vivo. E para isso
 * basta uma pergunta bem mais simples, que não exige palpite nenhum:
 *
 *     esta frase ainda aparece, escrita, em algum lugar do código?
 *
 * `presentes` é a resposta: TODO literal e TODO texto de JSX encontrados, sem
 * filtro de espécie alguma. Uma linha do CSV só vira órfã se o texto dela não
 * estiver nem em `achados` nem aqui. Órfã de verdade é a que ninguém escreve
 * mais em lugar nenhum.
 */
/**
 * Todo texto escrito no código, em qualquer arquivo, de qualquer tamanho.
 *
 * Duas diferenças deliberadas em relação à varredura normal, e as duas existem
 * porque a pergunta aqui é outra — não é "isto é texto de tela?", é "isto ainda
 * está escrito em algum lugar?":
 *
 *   • entra TAMBÉM o que a varredura pula de propósito (`terms.ts`, `i18n.ts`,
 *     a pasta `admin`…). Pular serve para não ACRESCENTAR aquelas frases ao
 *     CSV; não serve para declará-las mortas. As seções dos Termos estão
 *     traduzidas nos sete idiomas e sumiriam todas.
 *   • o tamanho mínimo cai de 5 para 1 caractere. "Baú", "Mapa", "Pier", "mn"
 *     são rótulos do menu, traduzidos, e não chegam a cinco letras.
 */
const LITERAL_QUALQUER = /(['"`])([^'"`\n]{1,300})\1/g;

function tudoQueEstaEscrito() {
  const presentes = new Set();
  const PULAR = ['node_modules', '.git', 'dist', '.expo', 'backups', 'locales', '_rollback'];
  (function anda(dir) {
    for (const nome of readdirSync(dir)) {
      if (PULAR.includes(nome)) continue;
      const p = join(dir, nome);
      if (statSync(p).isDirectory()) { anda(p); continue; }
      if (!/\.tsx?$/.test(nome)) continue;
      const txt = semComentarios(readFileSync(p, 'utf8'));
      for (const linha of txt.split('\n')) {
        for (const m of linha.matchAll(LITERAL_QUALQUER)) presentes.add(desescapar(m[2].trim()));
        if (p.endsWith('.tsx')) {
          for (const m of linha.matchAll(TEXTO_JSX)) presentes.add(m[1].trim());
        }
      }
    }
  })(RAIZ);
  return presentes;
}

function varrer() {
  const achados = new Map();   // texto -> "arquivo:linha"  (o que eu SEI que é de tela)
  const presentes = tudoQueEstaEscrito();
  for (const base of [join(RAIZ, 'mobile'), join(RAIZ, 'backend', 'src')]) {
    if (!existsSync(base)) continue;
    for (const p of arquivos(base)) {
      const rel = relative(RAIZ, p).replace(/\\/g, '/');
      const cru = readFileSync(p, 'utf8');

      // 1) o caminho certo: o que está DENTRO de t(...) e tr(..., ...)
      const limpo = semComentarios(cru);
      for (const re of [CHAMADA_T, CHAMADA_TR]) {
        re.lastIndex = 0;
        for (const m of limpo.matchAll(re)) {
          const bruto = m[2];
          if (!ehTextoDeChamada(bruto)) continue;
          const t = desescapar(bruto);
          if (!achados.has(t)) achados.set(t, `${rel}:${linhaDoIndice(limpo, m.index)}`);
        }
      }

      // 2) o caminho do palpite, para os catálogos que guardam a frase longe
      //    da chamada
      const linhas = cru.split('\n');
      linhas.forEach((linha, i) => {
        const s = linha.trim();
        if (s.startsWith('*') || s.startsWith('//') || s.startsWith('/*')) return;
        for (const m of linha.matchAll(LITERAL)) {
          const bruto = m[2].trim();
          // A chave tem de ser o texto COMO ELE EXISTE EM EXECUÇÃO.
          const t = desescapar(bruto);
          presentes.add(t);
          if (!ehTexto(bruto, linha)) continue;
          if (!achados.has(t)) achados.set(t, `${rel}:${i + 1}`);
        }
        // Texto solto dentro de JSX, que não passa pelo caminho acima.
        if (p.endsWith('.tsx')) {
          for (const m of linha.matchAll(TEXTO_JSX)) {
            const bruto = m[1].trim();
            presentes.add(bruto);
            if (!ehTexto(bruto, linha)) continue;
            if (!achados.has(bruto)) achados.set(bruto, `${rel}:${i + 1}`);
          }
        }
      });
    }
  }
  // o que entrou em `achados` obviamente também está presente
  for (const t of achados.keys()) presentes.add(t);
  return { achados, presentes };
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
  const { achados, presentes } = varrer();

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
  //
  // ORFAO só quem sumiu MESMO. Uma frase que a varredura não reconheceu como
  // texto de tela, mas que continua escrita em algum canto do código, fica com
  // a situação em branco e segue sendo compilada. Marcar essa como órfã é o
  // erro caro: `compilar` pula órfã, e a tradução sumiria da tela calada.
  let mantidos = 0;
  for (const [texto, linha] of existentes) {
    if (achados.has(texto)) continue;
    if (presentes.has(texto)) {
      saida.push({ ...linha, situacao: '' });
      mantidos++;
    } else {
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
  console.log(`  ${mantidos} nao reconhecidos, mas AINDA escritos no codigo (mantidos)`);
  console.log(`  ${orfaos} orfaos de verdade (marcados, nao apagados)`);
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

  const destinos = [join(RAIZ, 'mobile', 'locales'), join(RAIZ, 'backend', 'src', 'locales')];

  // ── A trava ────────────────────────────────────────────────────────────────
  //
  // Compilar REESCREVE os catorze JSON do zero. Se por qualquer motivo uma
  // linha do CSV sumir ou for marcada órfã por engano, a tradução dela some da
  // tela em sete idiomas — e some calada, porque `t()` cai no português e
  // nenhuma tela quebra.
  //
  // Foi o que quase aconteceu em 23/09/2026: o extrator de então marcou 281
  // frases vivas como órfãs, e um `compilar` teria apagado 283 traduções.
  //
  // Então: antes de gravar, comparar com o que já está lá — e separar as duas
  // perdas possíveis, porque elas são coisas muito diferentes.
  //
  //   frase que sumiria e NÃO está mais escrita em lugar nenhum
  //       é faxina, e é o trabalho desta ferramenta. Passa, e só conta quantas.
  //
  //   frase que sumiria e AINDA ESTÁ ESCRITA no código
  //       é o acidente. Alguém veria a tela em português sem nada quebrar.
  //       Esta para tudo.
  //
  // É por isso que `compilar` varre o código, coisa que antes não fazia: sem
  // olhar o código não há como distinguir faxina de acidente, e quem não
  // distingue ou apaga demais (o que aconteceu) ou trava sempre (o que faria
  // ninguém mais usar a ferramenta).
  const escritos = tudoQueEstaEscrito();
  const faxina = new Set(), acidentes = new Set();
  for (const destino of destinos) {
    for (const idioma of idiomas) {
      const alvo = join(destino, `${idioma}.json`);
      if (!existsSync(alvo)) continue;
      let antigo = {};
      try { antigo = JSON.parse(readFileSync(alvo, 'utf8')); } catch { continue; }
      for (const chave of Object.keys(antigo)) {
        if (dic[idioma][chave] !== undefined) continue;
        (escritos.has(chave) ? acidentes : faxina).add(chave);
      }
    }
  }

  if (acidentes.size && !process.argv.includes('--force')) {
    console.error(`\nPAREI: ${acidentes.size} frase(s) sumiriam dos locales e AINDA estao escritas no codigo.\n`);
    [...acidentes].slice(0, 25).forEach((c) => console.error('  - ' + JSON.stringify(c).slice(0, 90)));
    if (acidentes.size > 25) console.error(`  ... e mais ${acidentes.size - 25}`);
    console.error(`
Cada uma esta traduzida hoje e sumiria da tela em sete idiomas, sem erro nenhum
aparecer — t() cairia no portugues.

Quase sempre a causa e a mesma: a linha ficou marcada ORFAO no CSV mas a frase
continua no codigo. Rode 'extrair' de novo e confira a coluna 'situacao'.

Se a remocao for mesmo desejada: rode de novo com --force.
`);
    process.exit(1);
  }

  for (const destino of destinos) {
    mkdirSync(destino, { recursive: true });
    for (const idioma of idiomas) {
      writeFileSync(join(destino, `${idioma}.json`), JSON.stringify(dic[idioma], null, 2) + '\n', 'utf8');
    }
  }
  if (faxina.size) console.log(`faxina: ${faxina.size} frase(s) que ninguem escreve mais sairam dos locales`);
  if (acidentes.size) console.log(`(--force) ${acidentes.size} frase(s) AINDA no codigo foram apagadas a pedido`);

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
