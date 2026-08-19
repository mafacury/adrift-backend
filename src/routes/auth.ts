import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { randomBytes, createHash } from 'node:crypto';
import { pool } from '../db/pool.js';
import { countryFromIp } from '../services/geo.js';
import { enviarEmail, emailDeRecuperacao, emailDeVerificacao, emailSenhaAlterada } from '../services/mail.js';
import { verificarCaptcha } from '../services/captcha.js';
import { config } from '../config/index.js';

interface RegisterBody {
  email: string;
  password: string;
  /** Marcado pela pessoa no cadastro. Sem isto não há conta. */
  accept_terms: boolean;
  /** Qual texto ela aceitou — ver mobile/constants/terms.ts. */
  terms_version: string;
  /** Turnstile. Só exigido quando TURNSTILE_SECRET está configurada. */
  captcha_token?: string;
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

/**
 * O endereço PÚBLICO deste servidor — não o do site.
 *
 * O Railway expõe o domínio em RAILWAY_PUBLIC_DOMAIN, então em produção isto se
 * resolve sozinho e continua certo se o domínio mudar. `API_URL` permite forçar
 * à mão; o literal é a última rede.
 */
function apiUrl(): string {
  if (process.env.API_URL) return process.env.API_URL.replace(/\/+$/, '');
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railway) return `https://${railway}`;
  return 'https://adrift-backend-production.up.railway.app';
}

/**
 * Cria um token de confirmação de e-mail e manda o link.
 *
 * Mesmo desenho do password_resets: o banco guarda só o HASH do token. Se o
 * banco vazar, os links de confirmação não vêm junto.
 *
 * Nunca lança. Cadastro não pode quebrar porque o e-mail não saiu — a conta já
 * existe, e a pessoa sempre pode pedir o link de novo em /auth/verify/resend.
 */
async function emitirVerificacao(userId: string, email: string): Promise<void> {
  try {
    const token = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(token).digest('hex');

    await pool.query(
      `INSERT INTO email_verifications (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '24 hours')`,
      [userId, hash],
    );

    // ATENÇÃO: este link aponta para o BACKEND, não para o site.
    //
    // Quem responde GET /auth/verify é esta aplicação. O site é estático e tem
    // reescrita de SPA: um link para adriftapp.fun/auth/verify carregaria o app
    // numa rota que não existe, e o handler daqui nunca seria chamado. Foi o que
    // aconteceu quando escrevi isto pela primeira vez — teria trancado para fora
    // todo usuário novo no dia em que a verificação fosse ligada.
    //
    // A recuperação de senha resolve o mesmo problema por outro caminho
    // (`/?reset=token` na raiz, tratado pelo app). Aqui vale mais apontar para
    // cá: a página de confirmação é servida pronta pelo servidor, então funciona
    // mesmo antes de o site ser republicado.
    const link = `${apiUrl()}/auth/verify?token=${token}`;
    const { assunto, html, texto } = emailDeVerificacao(link);
    await enviarEmail(email, assunto, html, texto);
  } catch (err) {
    console.error('[verificacao] falhou ao emitir para', userId, err);
  }
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
            captcha_token: { type: 'string', maxLength: 4000 },
          },
        },
      },
      // Cadastro é a porta da fábrica de contas. Teto bem mais apertado que o
      // geral, e ainda por cima esta rota roda um bcrypt de custo 12.
      config: { rateLimit: { max: config.antispam.rateLimitAuthMax, timeWindow: '1 minute' } },
    },
    async (req: FastifyRequest<{ Body: RegisterBody }>, reply: FastifyReply) => {
      const { email, password, accept_terms, terms_version, captcha_token } = req.body;

      // CAPTCHA antes de qualquer coisa cara: sem chave configurada isto passa
      // direto (e o boot avisa). Fica ANTES do bcrypt de propósito — não faz
      // sentido gastar 300ms de CPU com quem não provou ser gente.
      if (!(await verificarCaptcha(captcha_token, req.ip))) {
        return reply.code(400).send({
          error: 'captcha',
          message: 'Não consegui confirmar que você não é um robô. Recarregue a página e tente de novo.',
        });
      }

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

      // Manda o e-mail de confirmação sempre que a exigência estiver ligada.
      // Sem RESEND_API_KEY o link sai no log do servidor (ver mail.ts) — dá
      // para testar o fluxo inteiro hoje, sem fornecedor.
      if (config.antispam.requireEmailVerification) {
        await emitirVerificacao(user.id, user.email);
        return reply.code(201).send({
          precisaVerificar: true,
          message: 'Conta criada. Confirme o seu e-mail pelo link que enviamos para entrar.',
        });
      }

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
      // Cada tentativa custa um bcrypt de custo 12. Sem teto, dez requisições
      // por segundo seguram a CPU da instância e derrubam o app para todo mundo.
      config: { rateLimit: { max: config.antispam.rateLimitAuthMax, timeWindow: '1 minute' } },
    },
    async (req: FastifyRequest<{ Body: LoginBody }>, reply: FastifyReply) => {
      const { email, password } = req.body;

      const { rows } = await pool.query(
        `SELECT id, email, password_hash, ban_status, role, email_verified
           FROM users WHERE email = $1`,
        [email.toLowerCase()],
      );

      if (!rows.length) {
        return reply.code(401).send({ error: 'Email ou senha incorretos.' });
      }

      const user = rows[0];

      if (user.ban_status === 'banned') {
        return reply.code(403).send({ error: 'Conta suspensa.' });
      }

      // Só barra quando a exigência está ligada. Contas anteriores à migração
      // 025 nasceram com email_verified = true — ninguém é trancado para fora
      // por uma regra criada depois de ele entrar.
      if (config.antispam.requireEmailVerification && user.email_verified === false) {
        await emitirVerificacao(user.id, user.email);
        return reply.code(403).send({
          error: 'email_nao_verificado',
          message: 'Confirme o seu e-mail para entrar. Acabamos de reenviar o link.',
        });
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
            // email_verified = TRUE: quem entra pelo Google já provou o e-mail
            // lá. Mandá-lo confirmar de novo seria pedir duas vezes a mesma
            // coisa — e, pior, o padrão da coluna é FALSE, então sem esta linha
            // ele nasceria trancado no dia em que a verificação for exigida.
            `INSERT INTO users (email, oauth_provider, oauth_id, country_code,
                                terms_accepted_at, terms_version, email_verified)
             VALUES ($1, 'google', $2, $3, NOW(), $4, TRUE)
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

      // Confirma a troca por e-mail. Quem trocou já sabe e ignora; quem NÃO
      // trocou descobre agora que perdeu a conta, enquanto ainda dá tempo de
      // reagir. Vai sem await e sem quebrar a resposta: a senha já mudou, e
      // falha de e-mail não pode virar erro para quem acabou de trocá-la.
      void (async () => {
        try {
          const { rows: u } = await pool.query(
            'SELECT email FROM users WHERE id = $1', [user_id],
          );
          if (!u.length) return;
          const { assunto, html, texto } = emailSenhaAlterada(new Date());
          await enviarEmail(u[0].email, assunto, html, texto);
        } catch (err) {
          console.error('[auth] aviso de senha alterada falhou:', err);
        }
      })();

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

  // ── GET /auth/verify ───────────────────────────────────────────────────────
  // Aberta pelo link do e-mail, direto no navegador. Responde HTML, não JSON:
  // quem chega aqui é uma pessoa olhando uma página, não o app chamando a API.
  app.get<{ Querystring: { token?: string } }>(
    '/auth/verify',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const token = req.query.token ?? '';
      const hash = createHash('sha256').update(token).digest('hex');

      const { rows } = await pool.query(
        `SELECT id, user_id FROM email_verifications
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
        [hash],
      );

      const ok = rows.length > 0;
      if (ok) {
        // uso único: marca o token e a conta na mesma ida ao banco
        await pool.query(
          `UPDATE email_verifications SET used_at = NOW() WHERE id = $1`,
          [rows[0].id],
        );
        await pool.query(
          `UPDATE users SET email_verified = TRUE WHERE id = $1`,
          [rows[0].user_id],
        );
      }

      const base = process.env.APP_URL ?? 'https://adriftapp.fun';
      const titulo = ok ? 'E-mail confirmado' : 'Link inválido ou vencido';
      const corpo = ok
        ? 'Pronto. A sua conta está liberada — pode entrar no Adrift e lançar o primeiro barco.'
        : 'Este link já foi usado ou passou das 24 horas. Tente entrar no app: mandamos um link novo automaticamente.';

      return reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo} — Adrift</title></head>
<body style="margin:0;background:#0B1A2E;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:460px;margin:14vh auto;background:#F7F3EA;border-radius:16px;padding:34px 28px;text-align:center">
    <h1 style="margin:0 0 10px;font-size:22px;color:#17456B;font-weight:600">${titulo}</h1>
    <p style="margin:0 0 24px;font-size:14.5px;line-height:22px;color:#3A5069">${corpo}</p>
    <a href="${base}" style="display:inline-block;background:#2E86AB;color:#fff;text-decoration:none;
       padding:13px 28px;border-radius:24px;font-size:15px;font-weight:600">Ir para o Adrift</a>
  </div>
</body></html>`);
    },
  );

  // ── POST /auth/verify/resend ───────────────────────────────────────────────
  // Resposta sempre igual, pelo mesmo motivo de /auth/forgot: não é para virar
  // uma consulta de "este e-mail tem conta?".
  app.post<{ Body: { email: string } }>(
    '/auth/verify/resend',
    {
      schema: { body: { type: 'object', required: ['email'],
        properties: { email: { type: 'string' } } } },
      config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
    },
    async (req, reply) => {
      const resposta = { status: 'ok' as const,
        message: 'Se houver conta com este e-mail aguardando confirmação, o link foi reenviado.' };

      const { rows } = await pool.query(
        `SELECT id, email FROM users
          WHERE email = $1 AND email_verified = FALSE AND ban_status <> 'banned'`,
        [req.body.email.toLowerCase()],
      );
      if (rows.length) await emitirVerificacao(rows[0].id, rows[0].email);

      return reply.send(resposta);
    },
  );
}
