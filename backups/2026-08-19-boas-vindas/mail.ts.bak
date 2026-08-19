/**
 * Envio de e-mail.
 *
 * Uma porta com TRÊS saídas, tentadas nesta ordem:
 *
 *   COM `SMTP_HOST`       servidor de e-mail do próprio domínio (Hostinger).
 *                         NÃO FUNCIONA NO RAILWAY — ver abaixo.
 *   COM `RESEND_API_KEY`  API do Resend, por HTTPS. É o caminho que funciona.
 *   SEM nenhum dos dois   escreve o e-mail no log do servidor, inteiro, com o
 *                         link clicável.
 *
 * A terceira saída não é preguiça: é o que permite testar o fluxo sem gastar
 * cota nem mandar mensagem para ninguém de verdade.
 *
 * ── A história, porque ela se repete ────────────────────────────────────────
 *
 * Em 18/08/2026 troquei Resend por SMTP ao descobrir que o DNS de adriftapp.fun
 * já estava pronto para enviar pela Hostinger:
 *
 *   SPF    v=spf1 include:_spf.mail.hostinger.com ~all
 *   DKIM   hostingermail-a._domainkey  (chave publicada)
 *   DMARC  v=DMARC1; p=none
 *
 * O raciocínio estava certo e a conclusão errada, porque eu olhei só uma ponta
 * da conexão. No dia seguinte, com o SMTP configurado e nenhum e-mail chegando,
 * a sonda de portas rodada de DENTRO do contêiner deu isto:
 *
 *   172.65.255.143 → 465:timeout 587:timeout 25:timeout | controle 443:abre
 *
 * O Railway BLOQUEIA a saída em todas as portas de SMTP, como quase todo PaaS
 * faz para não virar fonte de spam. A saída de rede funciona (443 abre); só
 * e-mail não passa. Nenhuma senha, porta ou ajuste de DNS resolve isso — é por
 * isso que serviço de e-mail transacional fala HTTPS.
 *
 * A lição, que vale além de e-mail: antes de escolher um protocolo, ver se o
 * lugar onde o código roda deixa ele sair.
 *
 * O SMTP fica aqui inteiro, e funcionaria numa VPS ou em qualquer host que não
 * bloqueie a porta. No Railway, use Resend.
 *
 * PARA LIGAR (no Railway):
 *   RESEND_API_KEY=re_...
 *   MAIL_FROM=Adrift <contact@adriftapp.fun>
 *
 * Enquanto o domínio não estiver verificado no Resend, ele só entrega para o
 * e-mail dono da conta e exige remetente onboarding@resend.dev. Verificar o
 * domínio (menu Domains) libera o remetente próprio — e aí `contact@` vale,
 * com a vantagem sobre um `nao-responda@` de que quem responder cai numa caixa
 * que existe de verdade, na Hostinger.
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

/**
 * Testa a chave do Resend no boot, sem mandar e-mail nenhum.
 *
 * Pergunta a lista de domínios da conta — chamada barata e sem efeito. Se a
 * chave estiver errada, volta 401 e ficamos sabendo antes de alguém precisar
 * dela.
 *
 * O caso que motivou isto: chave colada COM ASPAS num painel de variáveis. Ela
 * "parece" certa a olho nu e o valor real vira `"re_..."`, com as aspas dentro.
 * O cabeçalho sai como `Bearer "re_..."` e o servidor recusa. Por isso o
 * diagnóstico também diz se a chave tem aspas ou espaços em volta: é um erro
 * invisível de outra forma.
 */
export type EstadoResend = 'nao-configurado' | 'ok' | 'falha';
let estadoResend: EstadoResend = 'nao-configurado';
let motivoResend = '';

export function estadoDoResend(): { estado: EstadoResend; motivo: string } {
  return { estado: estadoResend, motivo: motivoResend };
}

export async function conferirResend(): Promise<void> {
  const bruta = process.env.RESEND_API_KEY;
  if (!bruta) { estadoResend = 'nao-configurado'; return; }

  const suja = bruta !== bruta.trim() || /^["']|["']$/.test(bruta.trim());
  const chave = limparChave(bruta);

  try {
    // POST vazio em /emails, de propósito. O Resend autentica ANTES de validar
    // o corpo, então as respostas se separam de forma limpa:
    //
    //   401  chave inválida
    //   422  chave VÁLIDA — só faltaram os campos, e nenhum e-mail foi enviado
    //
    // A tentativa anterior perguntava a lista de domínios, que exige permissão
    // de conta inteira. Uma chave criada com "Sending access" — que é a certa,
    // pela menor permissão possível — era recusada ali mesmo estando boa.
    const r = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 401 || r.status === 403) {
      estadoResend = 'falha';
      motivoResend = `HTTP ${r.status} — chave recusada${suja ? ' (veio com aspas/espaços)' : ''}`;
      console.error(`[mail] Resend NAO autenticou — ${motivoResend}`);
    } else {
      estadoResend = 'ok';
      motivoResend = suja ? 'chave aceita (tinha aspas/espaços — foram removidos)' : '';
      console.log(`[mail] Resend autenticado${suja ? ' (a chave veio com aspas; limpei)' : ''}`);
    }
  } catch (e: any) {
    estadoResend = 'falha';
    motivoResend = String(e?.message ?? e).slice(0, 120);
    console.error(`[mail] Resend: ${motivoResend}`);
  }
}

/**
 * Tira aspas e espaços que vêm de copiar e colar em painel de variáveis.
 *
 * Não é paranoia: Railway e afins guardam o valor LITERAL, então aspas digitadas
 * viram parte da chave. Melhor aceitar o descuido do que falhar em silêncio por
 * causa de dois caracteres.
 */
function limparChave(v: string): string {
  return v.trim().replace(/^["']|["']$/g, '').trim();
}

export async function enviarEmail(
  para: string, assunto: string, html: string, texto: string,
): Promise<boolean> {
  const chave = process.env.RESEND_API_KEY ? limparChave(process.env.RESEND_API_KEY) : undefined;
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

// ── A moldura de todo e-mail do Adrift ───────────────────────────────────────
/**
 * Logotipo em cima, rodapé embaixo, conteúdo no meio.
 *
 * Antes daqui cada modelo desenhava a própria caixa, e o aviso de barco em
 * notify.ts mandava um parágrafo solto sem nada em volta. Três lugares para
 * mudar a mesma coisa é o jeito garantido de os três divergirem.
 *
 * ── Decisões que valem explicar ────────────────────────────────────────────
 *
 * LOGOTIPO POR URL, não embutido. Gmail bloqueia `data:` em e-mail, então
 * imagem em base64 simplesmente não aparece. Anexo com CID funcionaria, mas faz
 * toda mensagem carregar o peso da imagem. URL hospedada é o que os serviços de
 * e-mail transacional usam. O custo: alguns clientes escondem imagem até a
 * pessoa permitir — por isso o `alt` diz "Adrift", e o texto nunca depende da
 * imagem para fazer sentido.
 *
 * NADA DE FLEXBOX OU GRID. O Outlook desenha e-mail com o motor do Word e
 * ignora os dois. Só bloco, largura explícita e estilo em linha.
 *
 * O RODAPÉ diz três coisas, nesta ordem de importância: para onde escrever
 * (a caixa existe de verdade e é a mesma dos Termos), onde fica o app, e por
 * que a pessoa recebeu isto. A última evita a leitura de "por que estão me
 * mandando e-mail?", que é o começo de uma denúncia de spam.
 */
const APP_URL = process.env.APP_URL ?? 'https://adriftapp.fun';
const CONTATO = 'contact@adriftapp.fun';

interface Moldura {
  titulo: string;
  /** Parágrafos do corpo, já em texto simples. */
  paragrafos: string[];
  botao?: { texto: string; href: string };
  /** Linha miúda depois do botão (prazo, validade). */
  nota?: string;
}

function moldar({ titulo, paragrafos, botao, nota }: Moldura): string {
  const corpo = paragrafos
    .map((p) => `      <p style="margin:0 0 14px;font-size:14.5px;line-height:22px;color:#3A5069">${p}</p>`)
    .join('\n');

  const chamada = botao
    ? `      <p style="margin:18px 0 22px">
        <a href="${botao.href}" style="display:inline-block;background:#2E86AB;color:#ffffff;
           text-decoration:none;padding:13px 26px;border-radius:24px;font-size:15px;
           font-weight:600">${botao.texto}</a>
      </p>`
    : '';

  const miudo = nota
    ? `      <p style="margin:0 0 4px;font-size:12.5px;line-height:19px;color:#6B7F94">${nota}</p>`
    : '';

  return `
<div style="background:#0B1A2E;padding:32px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:480px;margin:0 auto;background:#F7F3EA;border-radius:16px;padding:30px 28px 24px">

    <p style="margin:0 0 22px;text-align:center">
      <a href="${APP_URL}" style="text-decoration:none">
        <img src="${APP_URL}/logo-email.png" alt="Adrift" width="150"
             style="width:150px;max-width:60%;height:auto;border:0;display:inline-block">
      </a>
    </p>

    <h1 style="margin:0 0 14px;font-size:21px;line-height:28px;color:#17456B;font-weight:600">${titulo}</h1>
${corpo}
${chamada}
${miudo}

    <div style="margin-top:26px;padding-top:16px;border-top:1px solid rgba(23,69,107,0.16)">
      <p style="margin:0 0 6px;font-size:12px;line-height:18px;color:#6B7F94">
        Dúvidas ou problemas? Escreva para
        <a href="mailto:${CONTATO}" style="color:#2E86AB;text-decoration:none">${CONTATO}</a>.
      </p>
      <p style="margin:0 0 6px;font-size:12px;line-height:18px;color:#6B7F94">
        <a href="${APP_URL}" style="color:#2E86AB;text-decoration:none">${APP_URL.replace(/^https?:\/\//, '')}</a>
        — mensagens em garrafas, de estranho em estranho pelo mundo.
      </p>
      <p style="margin:0;font-size:11.5px;line-height:17px;color:#93A5B5">
        Você recebeu este e-mail porque tem uma conta no Adrift. Só mandamos
        mensagem sobre a sua conta e os seus barcos — nunca propaganda.
      </p>
    </div>

  </div>
</div>`.trim();
}

/** O mesmo rodapé, para a versão em texto puro. */
function rodapeTexto(): string {
  return [
    '',
    '—',
    `Dúvidas? Escreva para ${CONTATO}`,
    APP_URL,
    '',
    'Você recebeu este e-mail porque tem uma conta no Adrift.',
  ].join('\n');
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
  ].join('\n') + rodapeTexto();

  const html = moldar({
    titulo: 'Recuperar a sua senha',
    paragrafos: [
      'Alguém pediu para recuperar a senha desta conta no Adrift. Para escolher uma senha nova, toque no botão:',
    ],
    botao: { texto: 'Escolher senha nova', href: link },
    nota: 'O link vale por 1 hora e só funciona uma vez. Se não foi você, ignore esta mensagem — nada muda enquanto o link não for usado, e a sua senha atual continua valendo.',
  });

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
  ].join('\n') + rodapeTexto();

  const html = moldar({
    titulo: 'Bem-vindo ao Adrift',
    paragrafos: [
      'Falta um passo para o seu primeiro barco ir ao mar: confirme que este endereço é seu.',
    ],
    botao: { texto: 'Confirmar meu e-mail', href: link },
    nota: 'O link vale por 24 horas e só funciona uma vez. Se não foi você que se cadastrou, ignore esta mensagem — sem a confirmação a conta não é usada por ninguém.',
  });

  return { assunto, html, texto };
}

/**
 * Confirmação de que a senha mudou.
 *
 * Não é aviso de cortesia: é o único momento em que dá para reagir a uma conta
 * invadida. Quem trocou a senha já sabe que trocou e ignora este e-mail; quem
 * NÃO trocou descobre agora, enquanto ainda dá tempo.
 *
 * Por isso ele não tem botão. O que a pessoa precisa fazer, se não foi ela, é
 * falar com gente — e o endereço está no rodapé.
 */
export function emailSenhaAlterada(quando: Date): { assunto: string; html: string; texto: string } {
  const assunto = 'A sua senha do Adrift foi alterada';
  const hora = quando.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const texto = [
    `A senha da sua conta no Adrift foi alterada em ${hora} (horário de Brasília).`,
    '',
    'Se foi você, não precisa fazer nada.',
    '',
    'Se NÃO foi você, alguém teve acesso à sua conta. Escreva para',
    `${CONTATO} agora — quanto antes, melhor.`,
  ].join('\n') + rodapeTexto();

  const html = moldar({
    titulo: 'A sua senha foi alterada',
    paragrafos: [
      `A senha da sua conta no Adrift foi alterada em <strong>${hora}</strong> (horário de Brasília).`,
      'Se foi você, não precisa fazer nada.',
      `<strong>Se não foi você</strong>, alguém teve acesso à sua conta. Escreva para <a href="mailto:${CONTATO}" style="color:#2E86AB">${CONTATO}</a> agora — quanto antes, melhor.`,
    ],
  });

  return { assunto, html, texto };
}

/**
 * Aviso de banimento.
 *
 * Existe por obrigação do que os Termos prometem: contestação em até 30 dias.
 * Sem este e-mail o prazo corre sem a pessoa saber, e ela só descobre ao tentar
 * entrar — talvez depois dos 30 dias. Prometer um direito e não avisar que ele
 * começou a contar é o mesmo que não dar o direito.
 *
 * O tom é seco de propósito. Não é hora de simpatia nem de sermão: é hora de
 * dizer o que aconteceu, o que fazer, e até quando.
 */
export function emailDeBanimento(): { assunto: string; html: string; texto: string } {
  const assunto = 'A sua conta no Adrift foi suspensa';

  const texto = [
    'A sua conta no Adrift foi suspensa por violação dos Termos de Uso, e os',
    'seus barcos pararam de navegar.',
    '',
    'Você pode contestar uma vez, em até 30 dias a partir de hoje, escrevendo',
    `para ${CONTATO} a partir do e-mail desta conta. Uma pessoa analisa o caso`,
    'e responde.',
    '',
    'Se a contestação for aceita, a conta volta como estava. Se não for, a',
    'decisão é final.',
  ].join('\n') + rodapeTexto();

  const html = moldar({
    titulo: 'A sua conta foi suspensa',
    paragrafos: [
      'A sua conta no Adrift foi suspensa por violação dos Termos de Uso, e os seus barcos pararam de navegar.',
      `Você pode contestar <strong>uma vez, em até 30 dias</strong> a partir de hoje, escrevendo para <a href="mailto:${CONTATO}" style="color:#2E86AB">${CONTATO}</a> a partir do e-mail desta conta. Uma pessoa analisa o caso e responde.`,
      'Se a contestação for aceita, a conta volta como estava. Se não for, a decisão é final.',
    ],
  });

  return { assunto, html, texto };
}

/**
 * O aviso de barco, que antes saía como um parágrafo solto sem moldura.
 *
 * Exportado porque quem o dispara é o notify.ts, e o desenho dos e-mails tem
 * que morar num lugar só — foi por isso que esta moldura existe.
 */
export function emailDeAviso(
  titulo: string, corpo: string, url?: string, rotuloBotao?: string,
): { html: string; texto: string } {
  return {
    html: moldar({
      titulo,
      paragrafos: [corpo],
      botao: url
        ? { texto: rotuloBotao ?? 'Abrir o Adrift', href: `${APP_URL}${url}` }
        : undefined,
    }),
    texto: corpo + (url ? `\n\n${APP_URL}${url}` : '') + rodapeTexto(),
  };
}
