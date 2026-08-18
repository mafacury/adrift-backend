import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { config } from './config/index.js';
import { authRoutes } from './routes/auth.js';
import { boatRoutes } from './routes/boats.js';
import { userRoutes } from './routes/users.js';
import { adminRoutes } from './routes/admin.js';
import { demoRoutes } from './routes/demo.js';
import { startScheduler } from './services/scheduler.js';
import { pool } from './db/pool.js';
import { ensureBots } from './services/bots.js';

const app = Fastify({ logger: true, trustProxy: true });

await app.register(cors, { origin: true });
await app.register(jwt, { secret: config.jwtSecret });

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

// Start scheduler (moderação e roteamento rodam inline — sem Redis)
startScheduler();

// Garante os usuários virtuais espalhados pelo mundo (receptores automáticos)
void ensureBots().catch(console.error);

// Start server
const host = '0.0.0.0';
await app.listen({ port: config.port, host });
console.log(`[server] listening on port ${config.port}`);
