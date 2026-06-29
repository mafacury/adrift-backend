import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { config } from './config/index.js';
import { authRoutes } from './routes/auth.js';
import { boatRoutes } from './routes/boats.js';
import { userRoutes } from './routes/users.js';
import { startModerationWorker } from './workers/moderation.worker.js';
import { startRoutingWorker } from './workers/routing.worker.js';
import { startScheduler } from './services/scheduler.js';

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

// Routes
await app.register(authRoutes);
await app.register(boatRoutes);
await app.register(userRoutes);

// Health check
app.get('/health', async () => ({ status: 'ok' }));

// Start workers + scheduler
startModerationWorker();
startRoutingWorker();
startScheduler();

// Start server
const host = '0.0.0.0';
await app.listen({ port: config.port, host });
console.log(`[server] listening on port ${config.port}`);
