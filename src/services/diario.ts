/**
 * Diário de bordo — o e-mail que conta a quem sumiu o que o barco viveu.
 *
 * ── Por que existe ──────────────────────────────────────────────────────────
 *
 * Medido em 27/09/2026: das pessoas que chegaram no último mês, quase todas
 * vieram uma vez e não voltaram — e várias tinham dezenas de mensagens de
 * estranhos esperando no barco (um americano, 72). Ninguém avisou. Só a conta
 * do dono tinha push ligado; o e-mail era o único canal que alcançava os outros
 * e só era usado para prazo correndo e fim de jornada.
 *
 * ── As travas, porque e-mail é caro em reputação ────────────────────────────
 *
 *   - no máximo UM a cada 7 dias por pessoa (diario_enviado_at);
 *   - só se houve novidade desde a última visita ou o último diário — nada de
 *     "sentimos sua falta" vazio;
 *   - só para quem sumiu há 3+ dias: quem abre o app já viu tudo lá dentro;
 *   - nunca para e-mail não confirmado (erro de digitação vira devolução, e
 *     devolução derruba a entrega de todos os outros);
 *   - link de saída em todo diário, que funciona sem entrar na conta
 *     (GET /diario/sair), e chave no Perfil.
 *
 * Não é mão dupla ([[adrift-nunca-comunicacao-de-mao-dupla]]): o e-mail só
 * conta, e o único botão leva para dentro do app.
 */
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { config } from '../config/index.js';
import { enviarEmail, emailDoDiario } from './mail.js';
import { idiomaSuportado, tr } from './i18n.js';
import { semBloqueioEntre } from './bloqueio.js';

const DIAS_ENTRE_DIARIOS = 7;
/** Quem abriu o app há menos que isto já viu as novidades lá dentro. */
const DIAS_SUMIDO = 3;
/** Depois disto a conta é dada por fria — insistir vira perseguição. */
const DIAS_DESISTIR = 120;
const MAX_POR_RODADA = 100;

/** Mesma regra de routes/auth.ts: o endereço público DESTE servidor. */
function apiUrl(): string {
  if (process.env.API_URL) return process.env.API_URL.replace(/\/+$/, '');
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railway) return `https://${railway}`;
  return 'https://adrift-backend-production.up.railway.app';
}

/** Assinatura do link de saída: sem ela, qualquer um desligaria o diário alheio. */
export function assinaturaDoDiario(userId: string): string {
  return crypto.createHmac('sha256', config.jwtSecret)
    .update(`diario:${userId}`).digest('base64url').slice(0, 24);
}

export function linkDeSaida(userId: string): string {
  return `${apiUrl()}/diario/sair?u=${userId}&s=${assinaturaDoDiario(userId)}`;
}

function nomeDoPais(code: string, lang: string): string {
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export interface Novidades {
  mensagens: number;
  paises: number;
  presentes: number;
  esperando: number;
  trecho: { texto: string; pais: string } | null;
}

/** O que aconteceu nos barcos desta pessoa desde `desde`. */
export async function novidadesDe(userId: string, desde: Date): Promise<Novidades> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM boat_messages m JOIN boats b ON b.id = m.boat_id
         WHERE b.creator_user_id = $1 AND m.user_id <> $1 AND m.created_at > $2
           AND ${semBloqueioEntre('$1', 'm.user_id')})                        AS mensagens,
       (SELECT COUNT(DISTINCT h.country_code)::int FROM boat_hops h JOIN boats b ON b.id = h.boat_id
         WHERE b.creator_user_id = $1 AND h.hopped_at > $2
           AND h.country_code <> 'XX')                                       AS paises,
       (SELECT COUNT(*)::int FROM boat_messages m JOIN boats b ON b.id = m.boat_id
         WHERE b.creator_user_id = $1 AND m.user_id <> $1 AND m.created_at > $2
           AND m.gift_id IS NOT NULL)                                         AS presentes,
       (SELECT COUNT(*)::int FROM receiver_queue q
         WHERE q.user_id = $1 AND q.status = 'pending'
           AND q.arrives_at <= NOW() AND q.expires_at > NOW())                AS esperando`,
    [userId, desde],
  );

  // Um trecho de verdade vale mais que qualquer número. De gente, quando há
  // (as frases dos bots são parecidas entre si); com mais de 10 minutos, para
  // já ter passado pela moderação; nunca de quem foi bloqueado.
  const { rows: t } = await pool.query(
    `SELECT m.content, m.country_code
       FROM boat_messages m
       JOIN boats b ON b.id = m.boat_id
       JOIN users a ON a.id = m.user_id
      WHERE b.creator_user_id = $1 AND m.user_id <> $1
        AND m.created_at > $2 AND m.created_at < NOW() - INTERVAL '10 minutes'
        AND m.country_code IS NOT NULL AND m.country_code <> 'XX'
        AND char_length(m.content) >= 12
        AND ${semBloqueioEntre('$1', 'm.user_id')}
      ORDER BY (a.oauth_provider IS DISTINCT FROM 'bot') DESC, m.created_at DESC
      LIMIT 1`,
    [userId, desde],
  );

  const r = rows[0];
  return {
    mensagens: r.mensagens, paises: r.paises, presentes: r.presentes, esperando: r.esperando,
    trecho: t[0] ? { texto: t[0].content, pais: t[0].country_code } : null,
  };
}

/** Monta e manda. Devolve se saiu. */
export async function mandarDiario(
  u: { id: string; email: string; lang: string | null }, n: Novidades,
): Promise<boolean> {
  const lang = idiomaSuportado(u.lang);
  const e = emailDoDiario({
    lang,
    mensagens: n.mensagens,
    paises: n.paises,
    presentes: n.presentes,
    esperando: n.esperando,
    trecho: n.trecho
      ? { texto: n.trecho.texto, pais: nomeDoPais(n.trecho.pais, lang) }
      : null,
    linkDeSaida: linkDeSaida(u.id),
  });
  return enviarEmail(u.email, e.assunto, e.html, e.texto);
}

/** A varredura diária. */
export async function diarioSweep(): Promise<void> {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, lang,
              GREATEST(last_active_at, COALESCE(diario_enviado_at, 'epoch'::timestamptz)) AS desde
         FROM users
        WHERE oauth_provider IS DISTINCT FROM 'bot'
          AND ban_status <> 'banned'
          AND deleted_at IS NULL
          AND email_verified
          AND NOT diario_off
          AND email NOT LIKE '%.invalid'
          AND last_active_at <  NOW() - INTERVAL '${DIAS_SUMIDO} days'
          AND last_active_at >= NOW() - INTERVAL '${DIAS_DESISTIR} days'
          AND (diario_enviado_at IS NULL
               OR diario_enviado_at < NOW() - INTERVAL '${DIAS_ENTRE_DIARIOS} days')
        ORDER BY last_active_at ASC
        LIMIT ${MAX_POR_RODADA}`,
    );

    let enviados = 0;
    for (const u of rows) {
      const n = await novidadesDe(u.id, new Date(u.desde));
      // sem novidade não há diário: e-mail vazio ensina a apagar sem ler
      if (n.mensagens === 0 && n.presentes === 0) continue;
      // Marca só o que saiu: falha de envio tenta de novo amanhã, em vez de
      // fingir que avisou e esperar mais uma semana.
      if (await mandarDiario(u, n)) {
        await pool.query(`UPDATE users SET diario_enviado_at = NOW() WHERE id = $1`, [u.id]);
        enviados++;
      }
    }
    if (enviados) console.log(`[diario] ${enviados} diário(s) de bordo enviado(s)`);
  } catch (err) {
    console.error('[diario] falhou', err);
  }
}

/** A página que o link de saída abre. Curta, no idioma da pessoa. */
export function paginaDeSaida(lang: string, ok: boolean): string {
  const titulo = ok
    ? tr(lang, 'Pronto: o diário de bordo não chega mais.')
    : tr(lang, 'Este link não é válido.');
  const corpo = ok
    ? tr(lang, 'Os avisos da sua conta continuam. Se mudar de ideia, dá para religar o diário no Perfil do Adrift.')
    : tr(lang, 'Para desligar o diário, use o link do e-mail mais recente ou a chave no Perfil do Adrift.');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Adrift</title></head>
<body style="margin:0;background:#0B1A2E;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:440px;margin:48px auto;background:#F7F3EA;border-radius:16px;padding:28px 24px">
<h1 style="margin:0 0 12px;font-size:20px;color:#17456B">${titulo}</h1>
<p style="margin:0 0 18px;font-size:14.5px;line-height:22px;color:#3A5069">${corpo}</p>
<a href="https://adriftapp.fun" style="color:#2E86AB">adriftapp.fun</a>
</div></body></html>`;
}
