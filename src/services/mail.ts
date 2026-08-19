/**
 * Envio de e-mail.
 *
 * Uma porta com TRÊS saídas, tentadas nesta ordem:
 *
 *   COM `SMTP_HOST`       manda pelo servidor de e-mail do próprio domínio
 *                         (Hostinger). É o caminho escolhido — ver abaixo.
 *   COM `RESEND_API_KEY`  manda pela API do Resend, sem biblioteca.
 *   SEM nenhum dos dois   escreve o e-mail no log do servidor, inteiro, com o
 *                         link clicável.
 *
 * A terceira saída não é preguiça: é o que permite testar o fluxo sem gastar
 * cota nem mandar mensagem para ninguém de verdade.
 *
 * ── Por que SMTP e não Resend ───────────────────────────────────────────────
 *
 * A conta era do Resend até 18/08/2026, quando conferi o DNS de adriftapp.fun e
 * descobri que ele JÁ ESTAVA pronto para enviar:
 *
 *   SPF    v=spf1 include:_spf.mail.hostinger.com ~all
 *   DKIM   hostingermail-a._domainkey  (chave publicada)
 *   DMARC  v=DMARC1; p=none
 *
 * Eu vinha dizendo que "o trabalho de verdade é o DNS, e é igual nos dois
 * caminhos". Não era: pela Hostinger estava feito, pelo Resend faltariam três
 * registros novos e uma conta. Autenticação de e-mail é o que separa "chega" de
 * "cai no spam", e ela já existia — só de um lado.
 *
 * O Resend continua aqui, inteiro. Se um dia o volume crescer (a Hostinger
 * limita bem mais que os 3.000/mês do plano grátis dele) ou a entrega piorar,
 * basta configurar a chave: `SMTP_HOST` vazio e ele assume, sem tocar em código.
 *
 * PARA LIGAR (no Railway):
 *   SMTP_HOST=smtp.hostinger.com
 *   SMTP_PORT=465
 *   SMTP_USER=contact@adriftapp.fun
 *   SMTP_PASS=<a senha da caixa>
 *   MAIL_FROM=Adrift <contact@adriftapp.fun>
 *
 * O remetente PRECISA ser a mesma caixa do SMTP_USER: a Hostinger recusa enviar
 * em nome de endereço que não seja o autenticado. E usar a caixa de verdade
 * como remetente tem uma vantagem sobre um `nao-responda@`: quem responder cai
 * em algum lugar em vez de receber devolução.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { promises as dns } from 'node:dns';

const RESEND_URL = 'https://api.resend.com/emails';

export function smtpLigado(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function envioRealLigado(): boolean {
  return smtpLigado() || !!process.env.RESEND_API_KEY;
}

/**
 * Uma conexão só, reaproveitada.
 *
 * Criar um transporte por e-mail enviado abre e fecha TLS toda vez — caro, e a
 * Hostinger reclama de excesso de conexões. O nodemailer faz o pool sozinho
 * desde que o objeto seja o mesmo.
 */
let transporte: Transporter | null = null;
let criadoEm = 0;
const VIDA_DO_TRANSPORTE = 60 * 60 * 1000;   // 1h: o IP do provedor pode mudar

/**
 * Conecta pelo IPv4, explicitamente.
 *
 * `smtp.hostinger.com` responde nos dois protocolos, e o contêiner do Railway
 * escolhia o IPv6 — para onde ele não tem rota. O erro em produção foi
 * `ESOCKET: connect ENETUNREACH 2606:4700:90:...:465`, e a senha nunca chegou a
 * ser testada: a conexão morria antes do login.
 *
 * O nodemailer pula a resolução quando o host já é um IP (lib/shared, em
 * `resolveHostname`), então resolvemos aqui e passamos o endereço. `servername`
 * mantém o SNI e a validação do certificado pelo NOME — sem ele, o TLS falharia
 * por não bater com o IP.
 */
async function pegarTransporte(): Promise<Transporter> {
  const nome = process.env.SMTP_HOST!;
  if (transporte && Date.now() - criadoEm < VIDA_DO_TRANSPORTE) return transporte;

  let alvo = nome;
  try {
    const v4 = await dns.resolve4(nome);
    if (v4.length) alvo = v4[0];
  } catch {
    // Sem resposta A: segue pelo nome. Pior que isso só não tentar.
  }

  if (transporte) transporte.close();
  const porta = parseInt(process.env.SMTP_PORT ?? '465', 10);
  transporte = nodemailer.createTransport({
    host: alvo,
    servername: nome,               // SNI: o certificado é do NOME, não do IP
    port: porta,
    secure: porta === 465,          // 465 = TLS direto; 587 = STARTTLS
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    pool: true,
    maxConnections: 2,
    // O envio nunca pode segurar uma requisição do app. Se o servidor de
    // e-mail estiver lento, desiste e o chamador segue a vida.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  } as any);
  criadoEm = Date.now();
  return transporte;
}

/**
 * Testa a conexão e a SENHA, uma vez, no boot.
 *
 * Sem isto, "a senha do SMTP está errada" só aparece quando alguém pede
 * recuperação de senha — e mesmo assim escondido no log, porque a resposta ao
 * usuário é neutra de propósito. Foi o que aconteceu em 19/08: três envios
 * tentados, nenhum chegou, e nada na tela dizia por quê.
 *
 * `verify()` do nodemailer abre a conexão, autentica e desliga. Se a senha
 * estiver errada, o erro é `EAUTH`.
 */
export type EstadoSmtp = 'nao-configurado' | 'ok' | 'falha';
let estadoSmtp: EstadoSmtp = 'nao-configurado';
let motivoSmtp = '';

export function estadoDoSmtp(): { estado: EstadoSmtp; motivo: string } {
  return { estado: estadoSmtp, motivo: motivoSmtp };
}

/**
 * Sonda TCP crua, sem SMTP nem TLS: a porta abre ou não abre?
 *
 * Serve para separar duas coisas que o erro do nodemailer mistura: "o provedor
 * de hospedagem bloqueia a saída nesta porta" e "o servidor de e-mail recusou".
 * Timeout aqui, com o IP certo, quer dizer bloqueio de saída — e nesse caso
 * nenhuma configuração de SMTP vai funcionar, é preciso trocar de caminho.
 */
async function portaAbre(ip: string, porta: number): Promise<string> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port: porta });
    const fim = (r: string) => { s.destroy(); resolve(r); };
    s.setTimeout(6000);
    s.once('connect', () => fim('abre'));
    s.once('timeout', () => fim('timeout'));
    s.once('error', (e: any) => fim(e?.code ?? 'erro'));
  });
}

/** Preenchido no boot quando o SMTP falha: diz quais portas saem daqui. */
let sondaPortas = '';
export function sondaDePortas(): string { return sondaPortas; }

export async function conferirSmtp(): Promise<void> {
  if (!smtpLigado()) { estadoSmtp = 'nao-configurado'; return; }
  try {
    await (await pegarTransporte()).verify();
    estadoSmtp = 'ok';
    motivoSmtp = '';
    console.log(`[mail] SMTP autenticado em ${process.env.SMTP_HOST} como ${process.env.SMTP_USER}`);
  } catch (e: any) {
    estadoSmtp = 'falha';
    motivoSmtp = `${e?.code ?? 'erro'}: ${String(e?.message ?? e).slice(0, 160)}`;
    console.error(`[mail] SMTP NAO AUTENTICOU — ${motivoSmtp}`);

    // Falhou: descobre se o problema é a saída bloqueada, e em quais portas.
    try {
      const nome = process.env.SMTP_HOST!;
      const v4 = await dns.resolve4(nome).catch(() => [nome]);
      const ip = v4[0];
      const [p465, p587, p25, https] = await Promise.all([
        portaAbre(ip, 465), portaAbre(ip, 587), portaAbre(ip, 25),
        portaAbre('1.1.1.1', 443),    // controle: a saída funciona para HTTPS?
      ]);
      sondaPortas = `${ip} → 465:${p465} 587:${p587} 25:${p25} | controle 443:${https}`;
      console.error(`[mail] sonda de portas — ${sondaPortas}`);
    } catch (err) {
      sondaPortas = `sonda falhou: ${String(err).slice(0, 80)}`;
    }
  }
}

export async function enviarEmail(
  para: string, assunto: string, html: string, texto: string,
): Promise<boolean> {
  const chave = process.env.RESEND_API_KEY;
  const de = process.env.MAIL_FROM ?? 'Adrift <onboarding@resend.dev>';

  // ── Saída 1: SMTP do próprio domínio ──────────────────────────────────────
  if (smtpLigado()) {
    try {
      const info = await (await pegarTransporte()).sendMail({
        from: de, to: para, subject: assunto, html, text: texto,
      });
      console.log(`[mail] enviado por SMTP para ${para} (${info.messageId})`);
      return true;
    } catch (e: any) {
      // Não cai para o Resend nem para o log: se o SMTP está configurado e
      // falhou, o motivo (senha errada, caixa cheia, porta bloqueada) precisa
      // aparecer inteiro em vez de sumir atrás de um caminho alternativo.
      console.error('[mail] SMTP falhou:', e?.code ?? '', e?.message ?? e);
      return false;
    }
  }

  if (!chave) {
    // Sem fornecedor: o e-mail vai para o log, com moldura para não se perder
    // no meio das outras linhas.
    console.log(
      '\n┌─ E-MAIL NÃO ENVIADO (falta SMTP_HOST ou RESEND_API_KEY) ────\n' +
      `│ para:    ${para}\n` +
      `│ assunto: ${assunto}\n` +
      '├─────────────────────────────────────────────────────────────\n' +
      texto.split('\n').map((l) => `│ ${l}`).join('\n') +
      '\n└─────────────────────────────────────────────────────────────\n',
    );
    return false;
  }

  try {
    const r = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${chave}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: de, to: [para], subject: assunto, html, text: texto }),
    });
    if (!r.ok) {
      // o corpo do erro do Resend diz o motivo (domínio não verificado, etc.)
      console.error('[mail] falha ao enviar:', r.status, await r.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('[mail] erro de rede:', e);
    return false;
  }
}

/** O e-mail de recuperação. Texto e HTML dizem a mesma coisa. */
export function emailDeRecuperacao(link: string): { assunto: string; html: string; texto: string } {
  const assunto = 'Recuperar a sua senha do Adrift';

  const texto = [
    'Alguém pediu para recuperar a senha desta conta no Adrift.',
    '',
    'Para escolher uma senha nova, abra o endereço abaixo:',
    link,
    '',
    'O link vale por 1 hora e só funciona uma vez.',
    '',
    'Se não foi você, ignore esta mensagem. Nada muda enquanto o link não for',
    'usado, e a sua senha atual continua valendo.',
    '',
    '— Adrift',
  ].join('\n');

  const html = `
<div style="background:#0B1A2E;padding:32px 0;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:480px;margin:0 auto;background:#F7F3EA;border-radius:16px;padding:32px 28px">
    <h1 style="margin:0 0 6px;font-size:22px;color:#17456B;font-weight:600">Recuperar a sua senha</h1>
    <p style="margin:0 0 20px;font-size:14.5px;line-height:22px;color:#3A5069">
      Alguém pediu para recuperar a senha desta conta no Adrift.
      Para escolher uma senha nova, toque no botão:
    </p>
    <p style="margin:0 0 22px">
      <a href="${link}" style="display:inline-block;background:#2E86AB;color:#fff;text-decoration:none;
         padding:13px 26px;border-radius:24px;font-size:15px;font-weight:600">Escolher senha nova</a>
    </p>
    <p style="margin:0 0 18px;font-size:12.5px;line-height:19px;color:#6B7F94">
      O link vale por 1 hora e só funciona uma vez.
    </p>
    <p style="margin:0;font-size:12.5px;line-height:19px;color:#6B7F94">
      Se não foi você, ignore esta mensagem. Nada muda enquanto o link não for usado,
      e a sua senha atual continua valendo.
    </p>
  </div>
  <p style="text-align:center;margin:18px 0 0;font-size:11px;color:rgba(243,237,224,0.45)">Adrift</p>
</div>`;

  return { assunto, html, texto };
}

/**
 * Confirmação de e-mail no cadastro.
 *
 * Mesmo molde do e-mail de recuperação — a diferença de tom é proposital: aqui
 * é boas-vindas, não socorro.
 */
export function emailDeVerificacao(link: string): { assunto: string; html: string; texto: string } {
  const assunto = 'Confirme o seu e-mail no Adrift';

  const texto = [
    'Bem-vindo ao Adrift.',
    '',
    'Falta um passo para o seu primeiro barco ir ao mar: confirme que este',
    'endereço é seu abrindo o link abaixo.',
    link,
    '',
    'O link vale por 24 horas e só funciona uma vez.',
    '',
    'Se não foi você que se cadastrou, ignore esta mensagem — sem a confirmação',
    'a conta não é usada por ninguém.',
    '',
    '— Adrift',
  ].join('\n');

  const html = `
<div style="background:#0B1A2E;padding:32px 0;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:480px;margin:0 auto;background:#F7F3EA;border-radius:16px;padding:32px 28px">
    <h1 style="margin:0 0 6px;font-size:22px;color:#17456B;font-weight:600">Bem-vindo ao Adrift</h1>
    <p style="margin:0 0 20px;font-size:14.5px;line-height:22px;color:#3A5069">
      Falta um passo para o seu primeiro barco ir ao mar: confirme que este
      endereço é seu.
    </p>
    <p style="margin:0 0 22px">
      <a href="${link}" style="display:inline-block;background:#2E86AB;color:#fff;text-decoration:none;
         padding:13px 26px;border-radius:24px;font-size:15px;font-weight:600">Confirmar meu e-mail</a>
    </p>
    <p style="margin:0 0 18px;font-size:12.5px;line-height:19px;color:#6B7F94">
      O link vale por 24 horas e só funciona uma vez.
    </p>
    <p style="margin:0;font-size:12.5px;line-height:19px;color:#6B7F94">
      Se não foi você que se cadastrou, ignore esta mensagem — sem a confirmação
      a conta não é usada por ninguém.
    </p>
  </div>
</div>`.trim();

  return { assunto, html, texto };
}
