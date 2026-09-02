/**
 * A página pública da jornada — o que sai quando alguém compartilha um barco.
 *
 * ── O que ela mostra, e o que NÃO mostra ────────────────────────────────────
 *
 * Mostra a VIAGEM: por onde o barco passou, quantos países, quantas milhas,
 * quantos dias, quantas pessoas escreveram.
 *
 * NÃO mostra o texto das mensagens. Quem escreveu para um barco do Adrift
 * escreveu para um objeto que passa de mão em mão entre estranhos — não para
 * uma página aberta na internet, indexável, que fica de pé para sempre. Essas
 * pessoas não estão aqui para consentir, e a diferença entre "sessenta pessoas
 * leram" e "qualquer um com o link lê" é a diferença entre correspondência e
 * publicação.
 *
 * E, na prática, o mapa é o que se compartilha bem. Ninguém posta parede de
 * texto; posta a rota que cruzou o mundo.
 *
 * ── Por que HTML servido pelo backend, e não uma tela do app ────────────────
 *
 * Três motivos. O link precisa abrir para quem NÃO tem conta — uma rota do app
 * cairia no guarda de autenticação. Precisa de OpenGraph para render bonito ao
 * ser colado no Instagram ou no WhatsApp, e isso exige HTML no servidor, não
 * uma SPA que monta depois. E funciona sem republicar o site por FTP.
 *
 * O id na URL é o UUID inteiro do barco: inadivinhável, então só vê quem
 * recebeu o link.
 */
import { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { REASON_LABEL, ArchiveReason, totalNauticalMiles } from '../services/journey.js';
import { COUNTRY_LANG } from '../services/country-data.js';
import { GIFTS } from '../services/gifts.js';

const APP_URL = process.env.APP_URL ?? 'https://adriftapp.fun';

/**
 * Os nomes dos oito modelos.
 *
 * A FONTE DA VERDADE é mobile/components/boat-stages.tsx — esta é uma cópia,
 * porque o servidor não importa do app. Ao mexer lá, mexa aqui.
 *
 * Escrevi esta lista com os nomes ANTIGOS, de antes da versão 1.15.0: os
 * estágios 5, 6 e 7 estavam como Transatlântica, Galeão e Navio. A página
 * pública mostrava um nome que o app não usa mais — o mesmo barco era "Bravia"
 * na tela e "Galeão" no link compartilhado.
 */
const ESTAGIO: Record<number, string> = {
  1: 'Novata', 2: 'Enseada', 3: 'Costeira', 4: 'Oceânica',
  5: 'Errante', 6: 'Bravia', 7: 'Soberana', 8: 'Nau Lendária',
};

/** Escapa o que vai para o HTML. Nome de país vem do banco, mas confiar é hábito ruim. */
function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}

export async function publicRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/j/:id', async (req, reply) => {
    const { id } = req.params;

    // UUID malformado não vai ao banco: erro de sintaxe do Postgres viraria 500.
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return reply.code(404).type('text/html; charset=utf-8').send(pagina404());
    }

    const { rows } = await pool.query(
      `SELECT b.id, b.status, b.stage, b.unique_countries, b.total_nm,
              b.created_at, b.archived_at, b.archive_reason,
              (SELECT COUNT(*)::int FROM boat_messages m
                WHERE m.boat_id = b.id AND m.user_id <> b.creator_user_id) AS escreveram,
              (SELECT COUNT(*)::int FROM boat_messages m
                WHERE m.boat_id = b.id AND m.gift_id IS NOT NULL)          AS presentes
         FROM boats b WHERE b.id = $1`,
      [id],
    );
    if (!rows.length) {
      return reply.code(404).type('text/html; charset=utf-8').send(pagina404());
    }
    const b = rows[0];

    // Barco recolhido pela moderação não vira cartão de visita.
    if (b.archive_reason === 'moderado') {
      return reply.code(404).type('text/html; charset=utf-8').send(pagina404());
    }

    // Ordem CRONOLÓGICA de primeira visita, não alfabética: a lista conta a
    // rota que o barco fez. `DISTINCT ON` obriga a ordenar pela chave primeiro,
    // então a reordenação por data acontece do lado de fora.
    const { rows: portos } = await pool.query(
      `SELECT country_code, name_pt FROM (
         SELECT DISTINCT ON (h.country_code)
                h.country_code, c.name_pt, h.hopped_at
           FROM boat_hops h LEFT JOIN countries c ON c.code = h.country_code
          WHERE h.boat_id = $1
          ORDER BY h.country_code, h.hopped_at ASC
       ) x ORDER BY x.hopped_at ASC`,
      [id],
    );

    // A mensagem inicial é do DONO do barco — as palavras dele, publicadas por
    // ele. É a única frase que a página pode mostrar sem pedir licença a
    // ninguém, e é a que dá contexto a todo o resto.
    const { rows: inicial } = await pool.query(
      `SELECT m.content, c.name_pt AS pais
         FROM boat_messages m
         JOIN boats b ON b.id = m.boat_id
         LEFT JOIN countries c ON c.code = m.country_code
        WHERE m.boat_id = $1 AND m.user_id = b.creator_user_id
        ORDER BY m.created_at ASC LIMIT 1`,
      [id],
    );

    // Quantos idiomas o barco atravessou. Textura de verdade sem publicar
    // palavra de ninguém: o número vem do país de cada porto, não do conteúdo.
    const idiomas = new Set(
      portos.map((p) => COUNTRY_LANG[p.country_code]).filter(Boolean),
    ).size;

    // Presentes deixados a bordo — são objetos, não palavras.
    const { rows: presentes } = await pool.query(
      `SELECT gift_id, COUNT(*)::int AS quantos
         FROM boat_messages WHERE boat_id = $1 AND gift_id IS NOT NULL
        GROUP BY gift_id ORDER BY quantos DESC LIMIT 8`,
      [id],
    );

    // `total_nm` só é congelado quando o barco atraca em casa. Para quem ainda
    // navega ele é nulo, e a página mostrava "0 milhas náuticas" ao lado de
    // "195 países" — um número que desmente o outro na mesma linha. Calcula na
    // hora, com a mesma conta do fim da jornada.
    const milhas = Number(b.total_nm) > 0
      ? Number(b.total_nm)
      : await totalNauticalMiles(id);

    const dias = Math.max(1, Math.round(
      ((b.archived_at ? new Date(b.archived_at) : new Date()).getTime()
        - new Date(b.created_at).getTime()) / 86_400_000,
    ));
    const codigo = String(b.id).slice(0, 5).toUpperCase();
    const modelo = ESTAGIO[b.stage] ?? 'Novata';
    const emCasa = b.status === 'archived';
    const selo = emCasa
      ? (REASON_LABEL[b.archive_reason as ArchiveReason] ?? 'Jornada encerrada')
      : 'Ainda navegando';

    const titulo = `Barco #${codigo} — ${b.unique_countries} ${b.unique_countries === 1 ? 'país' : 'países'}`;
    const resumo =
      `${dias} ${dias === 1 ? 'dia' : 'dias'} no mar, ` +
      `${milhas.toLocaleString('pt-BR')} milhas náuticas e ` +
      `${b.escreveram} ${b.escreveram === 1 ? 'pessoa que escreveu' : 'pessoas que escreveram'}.`;

    return reply.type('text/html; charset=utf-8').send(
      paginaJornada({
        titulo, resumo, codigo, modelo, selo, emCasa, dias,
        paises: b.unique_countries ?? 0,
        milhas,
        escreveram: b.escreveram ?? 0,
        portos: portos.map((p) => p.name_pt || p.country_code),
        idiomas,
        inicial: inicial[0]
          ? { texto: inicial[0].content as string, pais: (inicial[0].pais as string) ?? null }
          : null,
        presentes: presentes.map((g) => ({
          nome: GIFTS[g.gift_id]?.name ?? g.gift_id,
          emoji: GIFTS[g.gift_id]?.emoji ?? '🎁',
          quantos: g.quantos as number,
        })),
      }),
    );
  });
}

interface Dados {
  titulo: string; resumo: string; codigo: string; modelo: string; selo: string;
  emCasa: boolean; dias: number; paises: number; milhas: number;
  escreveram: number; portos: string[]; idiomas: number;
  /** A frase com que o dono soltou o barco. As palavras dele. */
  inicial: { texto: string; pais: string | null } | null;
  presentes: { nome: string; emoji: string; quantos: number }[];
}

function paginaJornada(d: Dados): string {
  const numero = (n: number, rot: string) => `
      <div style="text-align:center;padding:0 8px">
        <div style="font-size:30px;line-height:1.1;color:#17456B;font-weight:600">${n.toLocaleString('pt-BR')}</div>
        <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#7A96A8;margin-top:4px">${rot}</div>
      </div>`;

  // Teto de fichas. Um barco veterano passa de cem países, e cem fichas viram
  // uma parede que ninguém lê — o número grande lá em cima já disse quantos são.
  const TETO = 40;
  const ficha = (p: string) => `<span style="display:inline-block;background:rgba(23,69,107,.08);
      color:#17456B;border-radius:20px;padding:5px 12px;margin:0 5px 7px 0;font-size:12.5px">${esc(p)}</span>`;
  const sobra = d.portos.length - TETO;
  const listaPortos = d.portos.length
    ? d.portos.slice(0, TETO).map(ficha).join('') +
      (sobra > 0
        ? `<span style="display:inline-block;color:#7A96A8;font-size:12.5px;padding:5px 4px">
             e mais ${sobra} ${sobra === 1 ? 'país' : 'países'}</span>`
        : '')
    : '<span style="color:#7A96A8;font-size:13px">Ainda sem portos registrados.</span>';

  return `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.titulo)} — Adrift</title>
<meta name="description" content="${esc(d.resumo)}">
<!-- OpenGraph: é o que faz o link virar cartão ao ser colado no Instagram,
     WhatsApp ou Telegram. Sem isto o link aparece como texto cru. -->
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(d.titulo)}">
<meta property="og:description" content="${esc(d.resumo)}">
<meta property="og:image" content="${APP_URL}/logo-email.png">
<meta property="og:site_name" content="Adrift">
<meta name="twitter:card" content="summary">
</head>
<body style="margin:0;background:#0B1A2E;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:28px 18px 40px">

    <p style="text-align:center;margin:0 0 22px">
      <a href="${APP_URL}"><img src="${APP_URL}/logo-email.png" alt="Adrift" width="130"
         style="width:130px;max-width:50%;height:auto;border:0"></a>
    </p>

    <div style="background:#F7F3EA;border-radius:18px;padding:26px 24px">

      <div style="text-align:center;margin-bottom:22px">
        <div style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#7A96A8">Barco #${esc(d.codigo)}</div>
        <div style="font-size:26px;color:#17456B;font-weight:600;margin-top:2px">${esc(d.modelo)}</div>
        <div style="display:inline-block;margin-top:9px;padding:4px 13px;border-radius:20px;
             background:${d.emCasa ? 'rgba(39,174,96,.14)' : 'rgba(46,134,171,.14)'};
             color:${d.emCasa ? '#1E7A44' : '#2E86AB'};font-size:12px;font-weight:600">${esc(d.selo)}</div>
      </div>

      ${d.inicial ? `
      <div style="background:rgba(23,69,107,.05);border-left:3px solid #2E86AB;
           border-radius:0 10px 10px 0;padding:14px 16px;margin-bottom:20px">
        <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#7A96A8;margin-bottom:6px">
          A mensagem que soltou este barco
        </div>
        <div style="font-size:15px;line-height:23px;color:#17456B;font-style:italic">
          &ldquo;${esc(d.inicial.texto)}&rdquo;
        </div>
        ${d.inicial.pais ? `<div style="font-size:12px;color:#7A96A8;margin-top:7px">— de ${esc(d.inicial.pais)}</div>` : ''}
      </div>` : ''}

      <div style="display:flex;justify-content:space-around;flex-wrap:wrap;gap:14px 0;
           padding:18px 0;border-top:1px solid rgba(23,69,107,.12);border-bottom:1px solid rgba(23,69,107,.12)">
        ${numero(d.paises, 'países')}
        ${numero(d.milhas, 'milhas náuticas')}
        ${numero(d.dias, d.dias === 1 ? 'dia no mar' : 'dias no mar')}
        ${numero(d.escreveram, 'escreveram')}
        ${d.idiomas > 1 ? numero(d.idiomas, 'idiomas') : ''}
      </div>

      <p style="margin:20px 0 10px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#7A96A8">
        Portos visitados
      </p>
      <div>${listaPortos}</div>

      ${d.presentes.length ? `
      <p style="margin:22px 0 10px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#7A96A8">
        Deixaram a bordo
      </p>
      <div>${d.presentes.map((g) => `<span style="display:inline-block;background:rgba(245,197,24,.14);
        color:#8A6A10;border-radius:20px;padding:5px 12px;margin:0 5px 7px 0;font-size:12.5px">
        ${esc(g.emoji)} ${esc(g.nome)}${g.quantos > 1 ? ` ×${g.quantos}` : ''}</span>`).join('')}</div>` : ''}

      <p style="margin:22px 0 0;font-size:13px;line-height:20px;color:#5A7185;
         padding-top:16px;border-top:1px solid rgba(23,69,107,.12)">
        As outras ${d.escreveram} mensagens ficam com o barco. Elas foram escritas
        para quem o encontrasse no mar — e só se publica palavra de quem disse que pode.
      </p>

    </div>

    <div style="text-align:center;margin-top:24px">
      <a href="${APP_URL}" style="display:inline-block;background:#2E86AB;color:#fff;text-decoration:none;
         padding:14px 30px;border-radius:26px;font-size:15px;font-weight:600">Lançar o meu barco</a>
      <p style="margin:14px 0 0;font-size:12px;color:rgba(243,237,224,.5)">
        Adrift — barcos que levam mensagens de estranho em estranho pelo mundo.
      </p>
    </div>

  </div>
</body></html>`;
}

function pagina404(): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Barco não encontrado — Adrift</title></head>
<body style="margin:0;background:#0B1A2E;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:420px;margin:16vh auto;background:#F7F3EA;border-radius:16px;padding:32px 26px;text-align:center">
    <h1 style="margin:0 0 10px;font-size:21px;color:#17456B;font-weight:600">Este barco não está no mar</h1>
    <p style="margin:0 0 22px;font-size:14px;line-height:21px;color:#3A5069">
      O link pode estar errado, ou a jornada não é pública.
    </p>
    <a href="${APP_URL}" style="display:inline-block;background:#2E86AB;color:#fff;text-decoration:none;
       padding:12px 26px;border-radius:24px;font-size:15px;font-weight:600">Conhecer o Adrift</a>
  </div>
</body></html>`;
}
