#!/usr/bin/env node
/**
 * Envolve em `t(...)` os textos que estão no CSV.
 *
 *   node backend/scripts/aplicar-t.mjs           mostra o que faria
 *   node backend/scripts/aplicar-t.mjs --aplicar grava
 *
 * Por que uma ferramenta e não edição à mão: são 66 trocas em 20 arquivos, e
 * cada uma tem de casar o texto EXATO — um caractere de diferença e a tradução
 * some sem avisar. Máquina não erra nisso; gente erra na décima.
 *
 * O que ela NÃO faz, de propósito:
 *
 *   · não mexe em template com ${}. Ali o texto precisa virar `t('... {x}',
 *     {x})`, e decidir o nome de cada marcador é trabalho de gente. São
 *     listados no fim para eu tratar um a um.
 *   · não acrescenta `useIdioma()` na tela. Isso é decisão de onde, e mexer no
 *     corpo do componente automaticamente é como se quebra arquivo.
 *   · não toca em arquivo que já importa `t` — assume que já foi feito.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSV = join(RAIZ, '..', 'adrift-textos-para-traduzir.csv');
const APLICAR = process.argv.includes('--aplicar');

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

// ── quais textos, e onde ────────────────────────────────────────────────────
const linhas = csvLer(readFileSync(CSV, 'utf8').replace(/^\ufeff/, ''));
const cab = linhas[0];
const alvos = new Map();   // arquivo -> [texto, ...]
for (const l of linhas.slice(1)) {
  const o = {};
  cab.forEach((c, i) => { o[c] = String(l[i] ?? '').split('⏎').join('\n'); });
  if (!o.pt || /^(ORFAO|FALTA)/.test(o.situacao)) continue;
  const arq = o.arquivo.split(':')[0];
  if (!arq.startsWith('mobile/')) continue;          // fase 3 é só o cliente
  if (!alvos.has(arq)) alvos.set(arq, []);
  alvos.get(arq).push(o.pt);
}

/** Volta a escapar para caber dentro de aspas simples no código. */
function paraLiteral(s) {
  return s.split('\\').join('\\\\').split("'").join("\\'").split('\n').join('\\n');
}

let trocados = 0, comMarcador = [], naoAchados = [];
const tocados = new Set();

for (const [arq, textos] of alvos) {
  const caminho = join(RAIZ, arq);
  if (!existsSync(caminho)) { naoAchados.push(`${arq} (arquivo sumiu)`); continue; }
  let src = readFileSync(caminho, 'utf8');
  const antes = src;

  // Textos maiores primeiro: senão um trecho curto que é pedaço de outro maior
  // seria trocado antes e estragaria o maior.
  for (const texto of textos.sort((a, b) => b.length - a.length)) {
    if (texto.includes('${')) { comMarcador.push([arq, texto]); continue; }

    const lit = paraLiteral(texto);
    let achou = false;
    for (const aspa of ["'", '"', '`']) {
      const alvo = aspa + lit + aspa;
      if (!src.includes(alvo)) continue;
      // Já envolvido? Não envolver duas vezes.
      if (src.includes(`t(${alvo}`)) { achou = true; break; }
      src = src.split(alvo).join(`t('${lit}')`);
      achou = true;
      trocados++;
      break;
    }
    if (!achou) naoAchados.push(`${arq}: ${JSON.stringify(texto.slice(0, 45))}`);
  }

  if (src !== antes) {
    tocados.add(arq);
    if (APLICAR) writeFileSync(caminho, src, 'utf8');
  }
}

console.log(`${trocados} textos envolvidos em t() · ${tocados.size} arquivos`);
if (!APLICAR) console.log('(simulação — use --aplicar para gravar)');

if (comMarcador.length) {
  console.log(`\n${comMarcador.length} COM \${marcador} — precisam de mão:`);
  for (const [a, t] of comMarcador) console.log(`   ${a}\n      ${JSON.stringify(t.slice(0, 70))}`);
}
if (naoAchados.length) {
  console.log(`\n${naoAchados.length} NAO ENCONTRADOS no código:`);
  for (const n of naoAchados) console.log(`   ${n}`);
}
if (tocados.size) {
  console.log('\nARQUIVOS TOCADOS (cada um precisa do import e do useIdioma):');
  for (const a of [...tocados].sort()) console.log(`   ${a}`);
}
