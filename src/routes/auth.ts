import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool.js';
import { countryFromIp } from '../services/geo.js';

interface RegisterBody {
  email: string;
  password: string;
}

interface LoginBody {
  email: string;
  password: string;
}

interface GoogleBody {
  // Google ID token obtained by the mobile app after Google Sign-In
  idToken: string;
}

export async function authRoutes(app: FastifyInstance) {

  // ── POST /auth/register ────────────────────────────────────────────────────
  app.post<{ Body: RegisterBody }>(
    '/auth/register',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email:    { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8 },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Body: RegisterBody }>, reply: FastifyReply) => {
      const { email, password } = req.body;

      // Check if email already in use
      const { rows: existing } = await pool.query(
        'SELECT id FROM users WHERE email = $1',
        [email.toLowerCase()],
      );
      if (existing.length > 0) {
        return reply.code(409).send({ error: 'Email já cadastrado.' });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const countryCode  = await countryFromIp(req.ip);

      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, country_code)
         VALUES ($1, $2, $3)
         RETURNING id, email, created_at`,
        [email.toLowerCase(), passwordHash, countryCode],
      );
      const user = rows[0];

      const token = app.jwt.sign({ id: user.id, email: user.email, country: countryCode });

      return reply.code(201).send({ token, user: { id: user.id, email: user.email, country: countryCode } });
    },
  );

  // ── POST /auth/login ───────────────────────────────────────────────────────
  app.post<{ Body: LoginBody }>(
    '/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email:    { type: 'string' },
            password: { type: 'string' },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Body: LoginBody }>, reply: FastifyReply) => {
      const { email, password } = req.body;

      const { rows } = await pool.query(
        'SELECT id, email, password_hash, ban_status, role FROM users WHERE email = $1',
        [email.toLowerCase()],
      );

      if (!rows.length) {
        return reply.code(401).send({ error: 'Email ou senha incorretos.' });
      }

      const user = rows[0];

      if (user.ban_status === 'banned') {
        return reply.code(403).send({ error: 'Conta suspensa.' });
      }

      if (!user.password_hash) {
        // Account created via Google OAuth — no password set
        return reply.code(401).send({ error: 'Esta conta usa login com Google.' });
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return reply.code(401).send({ error: 'Email ou senha incorretos.' });
      }

      // Atualiza last_active_at e country_code a cada login
      const loginCountry = await countryFromIp(req.ip);
      await pool.query(
        'UPDATE users SET last_active_at = NOW(), country_code = $1 WHERE id = $2',
        [loginCountry, user.id],
      );

      const token = app.jwt.sign({ id: user.id, email: user.email, country: loginCountry, role: user.role });

      return reply.send({ token, user: { id: user.id, email: user.email, country: loginCountry, role: user.role } });
    },
  );

  // ── POST /auth/google ──────────────────────────────────────────────────────
  // Mobile app completes Google Sign-In and sends the ID token here.
  // We verify it with Google's tokeninfo endpoint (no extra SDK needed).
  app.post<{ Body: GoogleBody }>(
    '/auth/google',
    {
      schema: {
        body: {
          type: 'object',
          required: ['idToken'],
          properties: { idToken: { type: 'string' } },
        },
      },
    },
    async (req: FastifyRequest<{ Body: GoogleBody }>, reply: FastifyReply) => {
      const { idToken } = req.body;

      // Verify token with Google
      let googleUser: { sub: string; email: string };
      try {
        const res = await fetch(
          `https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`,
        );
        if (!res.ok) throw new Error('invalid token');
        const data = (await res.json()) as { sub?: string; email?: string; error?: string };
        if (data.error || !data.sub || !data.email) throw new Error('invalid token');
        googleUser = { sub: data.sub, email: data.email };
      } catch {
        return reply.code(401).send({ error: 'Token do Google inválido.' });
      }

      // Find or create user
      const { rows: existing } = await pool.query(
        `SELECT id, email, ban_status
         FROM users
         WHERE oauth_provider = 'google' AND oauth_id = $1`,
        [googleUser.sub],
      );

      let userId: string;
      let email: string;

      if (existing.length > 0) {
        const user = existing[0];
        if (user.ban_status === 'banned') {
          return reply.code(403).send({ error: 'Conta suspensa.' });
        }
        userId = user.id;
        email  = user.email;
        await pool.query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [userId]);
      } else {
        // Check if email already used with password
        const { rows: byEmail } = await pool.query(
          'SELECT id FROM users WHERE email = $1',
          [googleUser.email.toLowerCase()],
        );
        if (byEmail.length > 0) {
          // Link Google to existing account
          await pool.query(
            `UPDATE users SET oauth_provider = 'google', oauth_id = $1 WHERE id = $2`,
            [googleUser.sub, byEmail[0].id],
          );
          userId = byEmail[0].id;
        } else {
          const googleCountry = await countryFromIp(req.ip);
          const { rows } = await pool.query(
            `INSERT INTO users (email, oauth_provider, oauth_id, country_code)
             VALUES ($1, 'google', $2, $3)
             RETURNING id`,
            [googleUser.email.toLowerCase(), googleUser.sub, googleCountry],
          );
          userId = rows[0].id;
        }
        email = googleUser.email.toLowerCase();
      }

      const token = app.jwt.sign({ id: userId, email });
      return reply.send({ token, user: { id: userId, email } });
    },
  );

  // ── POST /auth/fcm-token ───────────────────────────────────────────────────
  // Mobile app sends its FCM push token after login
  app.post<{ Body: { fcmToken: string } }>(
    '/auth/fcm-token',
    {
      schema: {
        body: {
          type: 'object',
          required: ['fcmToken'],
          properties: { fcmToken: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      await pool.query(
        'UPDATE users SET fcm_token = $1 WHERE id = $2',
        [req.body.fcmToken, userId],
      );

      return reply.send({ status: 'ok' });
    },
  );
}
