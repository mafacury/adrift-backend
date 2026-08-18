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
import { startScheduler } from './services/scheduler.js';
import { pool } from './db/pool.js';
import { ensureBots } from './services/bots.js';
import { captchaLigado } from './services/captcha.js';

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
  void pool.query(
    `UPDATE users SET last_active_at = NOW()
     WHERE id = $1 AND last_active_at < NOW() - INTERVAL '5 minutes'`,
    [userId],
  ).catch(() => {});
});

// Routes
await app.register(authRoutes);
await app.register(boatRoutes);
await app.register(userRoutes);
await app.register(adminRoutes);
await app.register(demoRoutes); // TEMPORÁRIO — remover em produção

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
