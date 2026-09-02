import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { config } from './config/index.js';
import { authRoutes } from './routes/auth.js';
import { boatRoutes } from './routes/boats.js';
import { userRoutes } from './routes/users.js';
import { adminRoutes } from './routes/admin.js';
import { demoRoutes } from './routes/demo.js';
import { publicRoutes } from './routes/public.js';
import { startScheduler } from './services/scheduler.js';
import { pool } from './db/pool.js';
import { tr, idiomaSuportado } from './services/i18n.js';
import { ensureBots } from './services/bots.js';
import { captchaLigado } from './services/captcha.js';
import { conferirIA, estadoDaIA } from './services/moderation.js';
import { webPushLigado } from './services/notify.js';
import { envioRealLigado, smtpLigado, conferirSmtp, estadoDoSmtp, sondaDePortas, conferirResend, estadoDoResend } from './services/mail.js';
import { registrar, codigoDoErro, vaiRegistrar } from './services/rastro.js';

const app = Fastify({ logger: true, trustProxy: true });

await app.register(cors, { origin: true });
await app.register(jwt, { secret: config.jwtSecret });

/**
 * Limite de taxa por IP.
 *
 * Não havia nenhum. Isso deixava duas portas abertas de uma vez: força bruta de
 * senha sem trava, e — mais concreto — exaustão de CPU, porque cada tentativa de
 * login roda um bcrypt de custo 12 (centenas de ms). Numa instância só, algumas
 * dezenas de requisições simultâneas seguram o núcleo e derrubam o app inteiro.
 *
 * O teto geral é folgado (o app conversa bastante com o servidor). Quem aperta
 * de verdade é o teto por rota, aplicado nas que rodam bcrypt e na criação de
 * conta — ver routes/auth.ts.
 *
 * Guarda em memória, sem Redis: o Adrift roda numa instância só no Railway.
 * No dia em que forem duas, isto vira dois baldes independentes e cada teto
 * dobra na prática — a hora de apontar para um Redis é essa, não antes.
 */
await app.register(rateLimit, {
  global: true,
  max: config.antispam.rateLimitMax,
  timeWindow: '1 minute',
  // trustProxy já está ligado no Fastify; sem isto todo mundo vira o IP do Railway
  keyGenerator: (req) => req.ip,
  // `statusCode` PRECISA vir aqui dentro. Sem ele o Fastify não sabe que este
  // objeto é um 429 e responde 500 — o cliente ouve "o servidor quebrou" quando
  // a verdade é "você está indo rápido demais". Testado contra a produção.
  errorResponseBuilder: (_req, ctx) => ({
    statusCode: 429,
    error: 'muitas_requisicoes',
    message: `Devagar. Espere ${Math.ceil(ctx.ttl / 1000)}s e tente de novo.`,
  }),
});

// Auth hook — attach user to request if token present
app.addHook('preHandler', async (req) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      (req as any).user = await req.jwtVerify();
    } catch {
      // unauthenticated — routes enforce auth individually
    }
  }
});

/**
 * Trava da espiada administrativa.
 *
 * O token emitido por POST /admin/espiar/:id carrega `espiando: true`. Aqui é
 * onde "somente leitura" deixa de ser promessa e vira fato: qualquer método que
 * não seja GET é recusado, seja qual for a rota.
 *
 * A trava mora AQUI, e não na tela, por um motivo simples: esconder botão não
 * impede nada de quem falar direto com a API. E mora antes de tudo, para valer
 * também para rota que alguém criar amanhã sem lembrar que esta trava existe —
 * rota nova nasce protegida em vez de nascer aberta.
 */
app.addHook('preHandler', async (req, reply) => {
  const u = (req as any).user;
  if (!u?.espiando) return;
  if (req.method !== 'GET') {
    return reply.code(403).send({
      error: 'somente_leitura',
      message: 'Você está vendo a conta de outra pessoa. Nesta visão nada pode ser alterado.',
    });
  }
});

/**
 * Trava do banimento.
 *
 * Até aqui banir alguém tirava o acesso ao LOGIN, e só isso. Como nenhum token
 * do Adrift expira, quem fosse banido com o app aberto — que é todo mundo, já
 * que a pessoa estava usando quando aconteceu — seguia lançando barcos e
 * escrevendo em barcos de estranhos para sempre. Recebia o e-mail de banimento
 * e o app continuava funcionando. `ban_status` era conferido no login, na
 * recuperação de senha, no roteamento e no reengajamento; em rota autenticada,
 * em nenhuma.
 *
 * Vale só para quem escreve. Ler não faz mal a ninguém, e quem foi banido
 * precisa poder abrir o Termo e achar o endereço para contestar — trancar a
 * leitura seria trancar a porta da defesa. Mesma forma da trava da espiada
 * logo acima, e pelo mesmo motivo: mora aqui para que rota nova nasça
 * protegida em vez de nascer aberta.
 *
 * Uma consulta por requisição autenticada, na chave primária. Antes rodava só
 * na escrita, porque só o banimento importava e banido pode ler. A exclusão
 * mudou isso: quem apagou a conta não pode nem ler, e o token dela continua
 * válido — token do Adrift não expira. O custo é uma busca por chave primária,
 * que nesta escala fica no ruído; se um dia pesar, um cache curto de ids
 * apagados resolve sem tocar no resto.
 */
app.addHook('preHandler', async (req, reply) => {
  const userId = (req as any).user?.id;
  if (!userId) return;

  const { rows } = await pool.query(
    `SELECT ban_status, lang, deleted_at FROM users WHERE id = $1`,
    [userId],
  );
  const u = rows[0];
  if (!u) return;

  // Conta apagada: nada passa, nem leitura. Diferente do banimento, onde ler
  // continua liberado para a pessoa poder abrir o Termo e contestar — aqui
  // não há o que contestar, foi ela quem pediu. E o token dela continua
  // válido, porque token do Adrift não expira: sem esta trava, quem apagou a
  // conta seguiria dentro do app até fechar a aba.
  if (u.deleted_at) {
    return reply.code(403).send({
      error: 'conta_excluida',
      message: tr(idiomaSuportado(u.lang), 'Esta conta foi excluída a seu pedido.'),
    });
  }

  // O banimento vale só para quem ESCREVE. Ler não faz mal a ninguém, e quem
  // foi banido precisa poder abrir o Termo e achar o endereço para contestar —
  // trancar a leitura seria trancar a porta da defesa.
  if (u.ban_status !== 'banned' || req.method === 'GET') return;

  return reply.code(403).send({
    error: 'conta_suspensa',
    message: tr(idiomaSuportado(u.lang),
                'A sua conta está suspensa. Verifique o e-mail que enviamos.'),
  });
});

/**
 * Presença. `last_active_at` decide quem está elegível a receber barcos
 * (services/routing.ts), mas era escrito SÓ no login — e o token não expira,
 * então ninguém faz login duas vezes. Na prática a coluna media "quando essa
 * pessoa se cadastrou", e todo mundo era excluído do sorteio depois de 7 dias
 * de app aberto normalmente. Qualquer requisição autenticada agora conta como
 * presença.
 *
 * O WHERE segura a escrita: só grava se o registro já está velho, então é no
 * máximo uma escrita a cada 5 min por pessoa, por mais que o app consulte. E
 * vai sem await — presença não pode custar latência a ninguém.
 */
app.addHook('preHandler', async (req) => {
  const userId = (req as any).user?.id;
  if (!userId) return;
  // Espiar não é estar presente. Sem esta linha, abrir a conta de alguém a
  // marcaria como ativa agora — e `last_active_at` é o que decide quem recebe
  // barco (routing.ts). O administrador olhando mudaria a fila do mundo, que é
  // o oposto de "sem interferir".
  if ((req as any).user?.espiando) return;
  void pool.query(
    `UPDATE users SET last_active_at = NOW()
     WHERE id = $1 AND last_active_at < NOW() - INTERVAL '5 minutes'`,
    [userId],
  ).catch(() => {});
});

/**
 * O rastro.
 *
 * Dois ganchos porque as duas informações não estão disponíveis no mesmo
 * momento: o CORPO da resposta só existe no `onSend`, e o TEMPO só fecha no
 * `onResponse`. O primeiro guarda o código do erro no próprio `req`, o segundo
 * grava a linha.
 *
 * Fica depois de todos os `preHandler` e antes das rotas de propósito: rota
 * criada amanhã por alguém que nunca ouviu falar desta tabela já nasce sendo
 * registrada. Ver services/rastro.ts para o que entra e o que não entra.
 */
app.addHook('onSend', async (req, reply, payload) => {
  if (reply.statusCode >= 400) (req as any).erroDoRastro = codigoDoErro(payload);
  return payload;
});

app.addHook('onResponse', async (req, reply) => {
  // Sem a query string: `/admin/fila?email=fulano@…` levaria o e-mail de outra
  // pessoa para dentro do log, e o endereço já diz o que precisa dizer.
  const caminho = req.url.split('?')[0];
  if (!vaiRegistrar(req.method, caminho, reply.statusCode)) return;
  registrar({
    userId: (req as any).user?.id ?? null,
    reqId: String(req.id),
    method: req.method,
    path: caminho,
    status: reply.statusCode,
    ms: reply.elapsedTime,
    erro: (req as any).erroDoRastro ?? null,
  });
});

// Routes
await app.register(authRoutes);
await app.register(boatRoutes);
await app.register(userRoutes);
await app.register(adminRoutes);
await app.register(demoRoutes); // TEMPORÁRIO — remover em produção
// Página pública da jornada (/j/:id). Sem autenticação de propósito: o link
// é feito para ser aberto por quem não tem conta.
await app.register(publicRoutes);

// Health check
// O /health diz de que COMMIT e de quando é o processo que está no ar.
//
// Sem isso, verificar um deploy vira adivinhação: já aconteceu de eu concluir
// que uma mudança "não subiu" observando um evento de 5% por dez minutos, o
// que não prova nada. Data de início e commit provam.
const SUBIU_EM = new Date().toISOString();
app.get('/health', async () => ({
  status: 'ok',
  desde: SUBIU_EM,
  commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'desconhecido',
  // Quais canais de aviso estão de pé. Sem isto, descobrir que o e-mail está
  // desligado exige caçar uma linha no log — e foi o que aconteceu em 19/08,
  // com a busca ainda por cima soterrada por avisos repetidos. Nenhum segredo
  // sai daqui: só o NOME do caminho, nunca chave nem senha.
  canais: {
    email: smtpLigado() ? 'smtp' : (process.env.RESEND_API_KEY ? 'resend' : 'desligado'),
    // Resultado do teste de autenticação feito no boot: 'ok' quer dizer que a
    // senha foi aceita pelo servidor de e-mail, não que a mensagem chegou.
    smtp: estadoDoSmtp(),
    portas: sondaDePortas() || undefined,
    resend: estadoDoResend(),
    remetente: process.env.MAIL_FROM ?? '(padrão)',
    webpush: webPushLigado(),
  },
  // A IA sustenta TRÊS coisas de uma vez: a moderação, o banimento automático
  // (que conta rejeições da moderação) e o botão Traduzir. Quando a chave cai,
  // as três caem juntas e nenhuma reclama — antes daqui, descobrir exigia
  // caçar uma linha no log do Railway.
  ia: estadoDaIA(),
}));

/**
 * Estado das defesas, dito em voz alta no boot.
 *
 * Duas das cinco defesas antispam dependem de chave de terceiro e ficam
 * DESLIGADAS sem ela. Uma defesa desligada em silêncio é pior do que nenhuma:
 * dá a sensação de estar protegido. Então o servidor diz, toda vez que sobe,
 * o que está de pé e o que não está.
 */
console.log(
  '[defesas] ' +
  `limite de taxa: ${config.antispam.rateLimitMax}/min por IP · ` +
  `barcos por conta: ${config.antispam.maxActiveBoatsPerUser} · ` +
  `banimento automático: ${config.antispam.autobanBanAt} rejeições/24h`,
);
if (!captchaLigado()) {
  console.warn('[defesas] CAPTCHA DESLIGADO — falta TURNSTILE_SECRET. Cadastro em massa é possível.');
}
if (!webPushLigado()) {
  console.warn('[defesas] WEB PUSH DESLIGADO — faltam VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY. Quem usa pelo navegador nao sera avisado de barco nenhum com a aba fechada.');
} else {
  console.log(`[avisos] web push ligado · aviso de prazo ${config.push.avisoPrazoHoras}h antes de zarpar`);
}
// Confere a senha do SMTP agora, e não na primeira vez que alguem esquecer a
// senha. Vai sem await: se o servidor de e-mail estiver lento, o app sobe assim
// mesmo e /health conta o resultado quando ele chegar.
void conferirSmtp();
void conferirResend();
void conferirIA();
if (envioRealLigado()) {
  console.log(`[avisos] e-mail ligado por ${smtpLigado() ? 'SMTP (' + process.env.SMTP_HOST + ')' : 'Resend'}`);
} else {
  console.warn('[avisos] E-MAIL DESLIGADO — recuperação de senha e aviso de prazo só saem no log.');
}
if (!config.antispam.requireEmailVerification) {
  console.warn('[defesas] verificação de e-mail DESLIGADA — REQUIRE_EMAIL_VERIFICATION != true. Conta descartável é possível.');
}

// Start scheduler (moderação e roteamento rodam inline — sem Redis)
startScheduler();

// Garante os usuários virtuais espalhados pelo mundo (receptores automáticos)
void ensureBots().catch(console.error);

// Start server
const host = '0.0.0.0';
await app.listen({ port: config.port, host });
console.log(`[server] listening on port ${config.port}`);
