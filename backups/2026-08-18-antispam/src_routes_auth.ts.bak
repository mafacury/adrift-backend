import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { randomBytes, createHash } from 'node:crypto';
import { pool } from '../db/pool.js';
import { countryFromIp } from '../services/geo.js';
import { enviarEmail, emailDeRecuperacao } from '../services/mail.js';

interface RegisterBody {
  email: string;
  password: string;
  /** Marcado pela pessoa no cadastro. Sem isto não há conta. */
  accept_terms: boolean;
  /** Qual texto ela aceitou — ver mobile/constants/terms.ts. */
  terms_version: string;
}

interface LoginBody {
  email: string;
  password: string;
}

interface GoogleBody {
  // Google ID token obtained by the mobile app after Google Sign-In
  idToken: string;
  // Só exigidos quando a conta ainda NÃO existe: entrar numa conta antiga não
  // pede aceite de novo. O app ainda não tem botão do Google; quando tiver,
  // a tela precisa mandar estes dois campos ou o cadastro será recusado.
  accept_terms?: boolean;
  terms_version?: string;
}

export async function authRoutes(app: FastifyInstance) {

  // ── POST /auth/register ────────────────────────────────────────────────────
  app.post<{ Body: RegisterBody }>(
    '/auth/register',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password', 'accept_terms', 'terms_version'],
          properties: {
            email:         { type: 'string', format: 'email' },
            password:      { type: 'string', minLength: 8 },
            accept_terms:  { type: 'boolean' },
            terms_version: { type: 'string', minLength: 1, maxLength: 40 },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Body: RegisterBody }>, reply: FastifyReply) => {
      const { email, password, accept_terms, terms_version } = req.body;

      // O aceite é condição para existir conta, e a checagem tem que estar
      // AQUI: a caixa marcada na tela é conveniência do usuário: qualquer um
      // que fale direto com a API passaria por cima dela.
      if (accept_terms !== true) {
        return reply.code(400).send({ error: 'É preciso aceitar os Termos de Uso.' });
      }

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
        `INSERT INTO users (email, password_hash, country_code,
                            terms_accepted_at, terms_version)
         VALUES ($1, $2, $3, NOW(), $4)
         RETURNING id, email, created_at`,
        [email.toLowerCase(), passwordHash, countryCode, terms_version],
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

      // Atualiza last_active_at e country_code a cada login — o país segue a
      // pessoa quando ela viaja. Mas um IP que não resolve ('XX') NÃO apaga o
      // país que já se sabia: sem essa guarda, uma VPN ou um login pelo Wi-Fi
      // errado zeraria o país (e, com ele, o horizonte e a bandeira das
      // mensagens) de quem já estava certo — inclusive de quem acabou de
      // escolher o país à mão em /users/me/country.
      const detected = await countryFromIp(req.ip);
      const { rows: upd } = await pool.query(
        `UPDATE users
         SET last_active_at = NOW(),
             country_code = CASE WHEN $1 = 'XX' THEN country_code ELSE $1 END
         WHERE id = $2
         RETURNING country_code`,
        [detected, user.id],
      );
      const loginCountry = upd[0]?.country_code ?? detected;

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
          // conta nova pelo Google: mesma regra do cadastro por email
          if (req.body.accept_terms !== true || !req.body.terms_version) {
            return reply.code(400).send({ error: 'É preciso aceitar os Termos de Uso.' });
          }
          const googleCountry = await countryFromIp(req.ip);
          const { rows } = await pool.query(
            `INSERT INTO users (email, oauth_provider, oauth_id, country_code,
                                terms_accepted_at, terms_version)
             VALUES ($1, 'google', $2, $3, NOW(), $4)
             RETURNING id`,
            [googleUser.email.toLowerCase(), googleUser.sub, googleCountry, req.body.terms_version],
          );
          userId = rows[0].id;
        }
        email = googleUser.email.toLowerCase();
      }

      const token = app.jwt.sign({ id: userId, email });
      return reply.send({ token, user: { id: userId, email } });
    },
  );

  // ── POST /auth/forgot ──────────────────────────────────────────────────────
  //
  // Pede o link de recuperação.
  //
  // A resposta é SEMPRE a mesma, exista a conta ou não. Responder "e-mail não
  // encontrado" transformaria esta rota numa lista de quem tem conta no
  // Adrift, que é exatamente o tipo de coisa que um app sobre anonimato não
  // pode entregar.
  app.post<{ Body: { email?: string } }>(
    '/auth/forgot',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string', maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      const email = (req.body?.email ?? '').trim().toLowerCase();
      const resposta = { status: 'ok' as const };

      const { rows } = await pool.query(
        'SELECT id, ban_status FROM users WHERE email = $1',
        [email],
      );
      const user = rows[0];

      // conta inexistente ou banida: cala e devolve o mesmo "ok"
      if (!user || user.ban_status === 'banned') return reply.send(resposta);

      // Freio de mão contra bombardeio: três pedidos por hora por conta. Sem
      // isto, qualquer um enche a caixa de entrada de qualquer usuário.
      const { rows: recentes } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM password_resets
          WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
        [user.id],
      );
      if (recentes[0].n >= 3) return reply.send(resposta);

      // 32 bytes de aleatório real. O banco guarda só o hash.
      const token = randomBytes(32).toString('hex');
      const hash  = createHash('sha256').update(token).digest('hex');

      await pool.query(
        `INSERT INTO password_resets (user_id, token_hash, expires_at, requested_ip)
         VALUES ($1, $2, NOW() + INTERVAL '1 hour', $3)`,
        [user.id, hash, req.ip],
      );

      // O link cai na RAIZ com um parâmetro, e não em /reset: o site é uma
      // página só servida estaticamente, e um caminho inventado daria 404 no
      // servidor antes de o app existir para tratá-lo.
      const base = process.env.APP_URL ?? 'https://adriftapp.fun';
      const link = `${base}/?reset=${token}`;
      const { assunto, html, texto } = emailDeRecuperacao(link);
      await enviarEmail(email, assunto, html, texto);

      return reply.send(resposta);
    },
  );

  // ── POST /auth/reset ───────────────────────────────────────────────────────
  app.post<{ Body: { token?: string; password?: string } }>(
    '/auth/reset',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token', 'password'],
          properties: {
            token:    { type: 'string', minLength: 32, maxLength: 128 },
            password: { type: 'string', minLength: 8, maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      const { token, password } = req.body as { token: string; password: string };
      const hash = createHash('sha256').update(token).digest('hex');

      const { rows } = await pool.query(
        `SELECT id, user_id FROM password_resets
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
        [hash],
      );
      if (!rows.length) {
        return reply.code(400).send({ error: 'Link inválido ou vencido. Peça outro.' });
      }

      const { id, user_id } = rows[0];
      const senhaHash = await bcrypt.hash(password, 12);

      await pool.query('BEGIN');
      try {
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [senhaHash, user_id]);
        await pool.query('UPDATE password_resets SET used_at = NOW() WHERE id = $1', [id]);
        // Os outros links pendentes desta conta morrem junto. Trocar a senha é
        // dizer "perdi o controle disto"; deixar um segundo link vivo na caixa
        // de e-mail seria manter a porta que se acabou de fechar.
        await pool.query(
          `UPDATE password_resets SET used_at = NOW()
            WHERE user_id = $1 AND used_at IS NULL`,
          [user_id],
        );
        await pool.query('COMMIT');
      } catch (e) {
        await pool.query('ROLLBACK');
        throw e;
      }

      return reply.send({ status: 'ok' });
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
