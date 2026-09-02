import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/pool.js';
import { avisarBanimento } from '../services/enforcement.js';
import { limparCacheDeAjustes } from '../services/ajustes.js';

// Middleware shared by all admin routes
async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const user = (req as any).user;
  if (!user?.id) return reply.code(401).send({ error: 'unauthorized' });
  if (user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
}

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin);

  // ── GET /admin/stats ───────────────────────────────────────────────────────
  app.get('/admin/stats', async (_req, reply) => {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users)                                         AS total_users,
        (SELECT COUNT(*)::int FROM users WHERE ban_status = 'banned')             AS banned_users,
        (SELECT COUNT(*)::int FROM boats WHERE status = 'active')                 AS active_boats,
        (SELECT COUNT(*)::int FROM boats)                                         AS total_boats,
        (SELECT COUNT(*)::int FROM boat_messages)                                 AS total_messages,
        (SELECT COUNT(*)::int FROM boat_messages
           WHERE created_at > NOW() - INTERVAL '24 hours')                        AS messages_today,
        (SELECT COUNT(*)::int FROM reports)                                       AS total_reports,
        (SELECT COUNT(*)::int FROM users
           WHERE created_at > NOW() - INTERVAL '7 days')                          AS new_users_week
    `);
    return reply.send(rows[0]);
  });

  // ── GET /admin/users ───────────────────────────────────────────────────────
  app.get<{ Querystring: { page?: string; limit?: string; search?: string; status?: string } }>(
    '/admin/users',
    async (req, reply) => {
      const page   = Math.max(1, parseInt(req.query.page  ?? '1', 10));
      const limit  = Math.min(50, parseInt(req.query.limit ?? '20', 10));
      const offset = (page - 1) * limit;
      const search = req.query.search ?? null;
      const status = req.query.status ?? null;

      const { rows } = await pool.query(
        `SELECT
           u.id, u.email, u.country_code, u.reputation_score,
           u.ban_status, u.role, u.created_at, u.last_active_at,
           u.email_verified,
           (SELECT COUNT(*)::int FROM boats WHERE creator_user_id = u.id) AS boat_count
         FROM users u
         WHERE ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%')
           AND ($2::text IS NULL OR u.ban_status = $2)
         ORDER BY u.created_at DESC
         LIMIT $3 OFFSET $4`,
        [search, status, limit, offset],
      );

      const { rows: cnt } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM users
         WHERE ($1::text IS NULL OR email ILIKE '%' || $1 || '%')
           AND ($2::text IS NULL OR ban_status = $2)`,
        [search, status],
      );

      return reply.send({ users: rows, total: cnt[0].total, page, limit });
    },
  );

  // ── PATCH /admin/users/:id ─────────────────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Body: { ban_status?: string; role?: string; email_verified?: boolean };
  }>(
    '/admin/users/:id',
    async (req, reply) => {
      const { id } = req.params;
      const { ban_status, role, email_verified } = req.body ?? {};

      /**
       * Liberar à mão quem não conseguiu confirmar o e-mail.
       *
       * A verificação é uma porta, e toda porta prende alguém: e-mail que caiu
       * no spam, endereço digitado errado, provedor corporativo que engole
       * mensagem. Sem esta saída, a única alternativa seria mexer no banco na
       * mão — e quem está divulgando o app não pode depender disso para
       * destravar um usuário.
       *
       * Só libera, nunca tranca de volta: `false` aqui seria trancar alguém que
       * já entrou, e não há motivo administrativo para isso.
       */
      if (email_verified === true) {
        await pool.query(
          'UPDATE users SET email_verified = TRUE WHERE id = $1', [id],
        );
        console.log(`[admin] usuário ${id} liberado à mão (e-mail dado por confirmado)`);
      }

      if (ban_status) {
        if (!['active','warned','banned'].includes(ban_status))
          return reply.code(400).send({ error: 'ban_status inválido' });
        // Lê o estado anterior ANTES de gravar: só avisa quem ACABOU de ser
        // banido. Sem isto, salvar a mesma tela duas vezes manda o aviso de
        // novo — e este e-mail diz "você tem 30 dias a partir de hoje", então
        // repetir não é só chato, é errado.
        const { rows: antes } = await pool.query(
          'SELECT ban_status FROM users WHERE id = $1', [id],
        );
        await pool.query('UPDATE users SET ban_status = $1 WHERE id = $2', [ban_status, id]);
        if (ban_status === 'banned' && antes[0]?.ban_status !== 'banned') {
          void avisarBanimento(id);
        }
      }
      if (role) {
        if (!['user','admin'].includes(role))
          return reply.code(400).send({ error: 'role inválido' });
        await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
      }

      return reply.send({ status: 'ok' });
    },
  );

  // ── DELETE /admin/users/:id ────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/admin/users/:id',
    async (req, reply) => {
      await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
      return reply.send({ status: 'ok' });
    },
  );

  // ── GET /admin/boats ───────────────────────────────────────────────────────
  app.get<{ Querystring: { page?: string; limit?: string; status?: string; search?: string } }>(
    '/admin/boats',
    async (req, reply) => {
      const page   = Math.max(1, parseInt(req.query.page  ?? '1', 10));
      const limit  = Math.min(50, parseInt(req.query.limit ?? '20', 10));
      const offset = (page - 1) * limit;
      const status = req.query.status ?? null;
      const search = req.query.search ?? null;   // busca por e-mail do criador

      const { rows } = await pool.query(
        `SELECT
           b.id, b.status, b.stage, b.unique_countries, b.created_at, b.last_hop_at,
           u.email AS creator_email,
           (SELECT COUNT(*)::int FROM boat_messages WHERE boat_id = b.id) AS message_count,
           (SELECT COUNT(*)::int FROM boat_hops    WHERE boat_id = b.id) AS hop_count,
           LEFT(
             (SELECT content FROM boat_messages WHERE boat_id = b.id
              ORDER BY created_at ASC LIMIT 1), 80
           ) AS initial_message
         FROM boats b
         JOIN users u ON u.id = b.creator_user_id
         WHERE ($1::text IS NULL OR b.status = $1)
           AND ($4::text IS NULL OR u.email ILIKE '%' || $4 || '%')
         ORDER BY b.created_at DESC
         LIMIT $2 OFFSET $3`,
        [status, limit, offset, search],
      );

      const { rows: cnt } = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM boats b JOIN users u ON u.id = b.creator_user_id
         WHERE ($1::text IS NULL OR b.status = $1)
           AND ($2::text IS NULL OR u.email ILIKE '%' || $2 || '%')`,
        [status, search],
      );

      return reply.send({ boats: rows, total: cnt[0].total, page, limit });
    },
  );

  // ── PATCH /admin/boats/:id ─────────────────────────────────────────────────
  app.patch<{ Params: { id: string }; Body: { status: string } }>(
    '/admin/boats/:id',
    async (req, reply) => {
      const { status } = req.body ?? {};
      if (!['active','paused','archived'].includes(status))
        return reply.code(400).send({ error: 'status inválido' });
      await pool.query('UPDATE boats SET status = $1 WHERE id = $2', [status, req.params.id]);
      return reply.send({ status: 'ok' });
    },
  );

  // ── DELETE /admin/boats/:id ────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/admin/boats/:id',
    async (req, reply) => {
      await pool.query('DELETE FROM boats WHERE id = $1', [req.params.id]);
      return reply.send({ status: 'ok' });
    },
  );

  // ── GET /admin/messages ────────────────────────────────────────────────────
  app.get<{ Querystring: { page?: string; limit?: string } }>(
    '/admin/messages',
    async (req, reply) => {
      const page   = Math.max(1, parseInt(req.query.page  ?? '1', 10));
      const limit  = Math.min(50, parseInt(req.query.limit ?? '20', 10));
      const offset = (page - 1) * limit;

      const { rows } = await pool.query(
        `SELECT
           bm.id, bm.content, bm.country_code, bm.created_at,
           b.id AS boat_id, b.stage,
           u.email AS author_email,
           (SELECT COUNT(*)::int FROM reports WHERE message_id = bm.id) AS report_count
         FROM boat_messages bm
         JOIN boats b ON b.id = bm.boat_id
         JOIN users u ON u.id = bm.user_id
         ORDER BY bm.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );

      const { rows: cnt } = await pool.query(
        'SELECT COUNT(*)::int AS total FROM boat_messages',
      );

      return reply.send({ messages: rows, total: cnt[0].total, page, limit });
    },
  );

  // ── DELETE /admin/messages/:id ─────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/admin/messages/:id',
    async (req, reply) => {
      await pool.query('DELETE FROM boat_messages WHERE id = $1', [req.params.id]);
      return reply.send({ status: 'ok' });
    },
  );

  // ── GET /admin/reports ─────────────────────────────────────────────────────
  app.get<{ Querystring: { page?: string; limit?: string } }>(
    '/admin/reports',
    async (req, reply) => {
      const page   = Math.max(1, parseInt(req.query.page  ?? '1', 10));
      const limit  = Math.min(50, parseInt(req.query.limit ?? '20', 10));
      const offset = (page - 1) * limit;

      const { rows } = await pool.query(
        `SELECT
           r.id, r.created_at,
           bm.id AS message_id, bm.content AS message_content, bm.country_code,
           ru.email AS reporter_email,
           mu.email AS author_email,
           b.id AS boat_id, b.stage
         FROM reports r
         JOIN boat_messages bm ON bm.id = r.message_id
         JOIN users ru ON ru.id = r.reporter_user_id
         JOIN users mu ON mu.id = bm.user_id
         JOIN boats b  ON b.id  = bm.boat_id
         ORDER BY r.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );

      const { rows: cnt } = await pool.query(
        'SELECT COUNT(*)::int AS total FROM reports',
      );

      return reply.send({ reports: rows, total: cnt[0].total, page, limit });
    },
  );

  // ── DELETE /admin/reports/:id  (descarta o report sem deletar a mensagem) ───
  app.delete<{ Params: { id: string } }>(
    '/admin/reports/:id',
    async (req, reply) => {
      await pool.query('DELETE FROM reports WHERE id = $1', [req.params.id]);
      return reply.send({ status: 'ok' });
    },
  );

  // ── GET /admin/settings ────────────────────────────────────────────────────
  app.get('/admin/settings', async (_req, reply) => {
    const { rows } = await pool.query(
      'SELECT key, value, label, kind, help, updated_at FROM system_settings ORDER BY kind, key',
    );
    return reply.send({ settings: rows });
  });

  // ── PATCH /admin/settings ──────────────────────────────────────────────────
  app.patch<{ Body: { key: string; value: string } }>(
    '/admin/settings',
    async (req, reply) => {
      const { key, value } = req.body ?? {};
      if (!key || value === undefined)
        return reply.code(400).send({ error: 'key e value são obrigatórios' });

      const { rows } = await pool.query(
        `UPDATE system_settings SET value = $1, updated_at = NOW()
         WHERE key = $2 RETURNING key, value, label, kind, help, updated_at`,
        [value, key],
      );
      if (!rows.length) return reply.code(404).send({ error: 'configuração não encontrada' });

      // O roteamento guarda estes valores em cache para não consultar o banco
      // a cada barco. Sem esta linha, girar um botão no painel só teria efeito
      // um minuto depois — e quem gira ia girar de novo achando que não pegou.
      limparCacheDeAjustes();

      return reply.send({ setting: rows[0] });
    },
  );

  // ── GET /admin/fila ────────────────────────────────────────────────────────
  /**
   * O histórico da fila de uma pessoa — o que chegou, o que virou de cada um.
   *
   * Existe por causa de um barco que atracou, mandou a notificação e sumiu uma
   * hora depois, sem aviso de perda e sem a faixa de "barco passou". Os três
   * sintomas juntos são de uma causa só, e nenhum caminho do código explicava:
   * a resposta estava no dado, e não havia como olhar o dado.
   *
   * `status` conta a história inteira:
   *   pending    ainda com a pessoa
   *   delivered  respondeu (ou o bot respondeu, se for bot)
   *   skipped    deixou passar
   *   expired    venceu o prazo
   *   (some)     a linha não existe mais — barco apagado leva a fila junto
   */
  app.get<{ Querystring: { email?: string; limite?: string } }>(
    '/admin/fila',
    async (req, reply) => {
      const email = (req.query.email ?? '').trim().toLowerCase();
      if (!email) return reply.code(400).send({ error: 'informe ?email=' });

      const limite = Math.min(100, parseInt(req.query.limite ?? '30', 10));

      const { rows: quem } = await pool.query(
        `SELECT id, email, country_code, lang, ban_status, receiving_paused,
                last_active_at, created_at
           FROM users WHERE LOWER(email) = $1`,
        [email],
      );
      if (!quem.length) return reply.code(404).send({ error: 'usuário não encontrado' });

      const { rows: fila } = await pool.query(
        `SELECT rq.id, rq.boat_id, rq.status,
                rq.queued_at, rq.arrives_at, rq.expires_at,
                rq.avisado_chegada_at, rq.avisado_prazo_at, rq.avisado_perda_at,
                b.status AS boat_status, b.archive_reason, b.stage,
                (SELECT COUNT(*)::int FROM boat_messages m WHERE m.boat_id = rq.boat_id) AS mensagens
           FROM receiver_queue rq
           LEFT JOIN boats b ON b.id = rq.boat_id
          WHERE rq.user_id = $1
          ORDER BY rq.queued_at DESC
          LIMIT $2`,
        [quem[0].id, limite],
      );

      return reply.send({ usuario: quem[0], fila });
    },
  );

  // ── GET /admin/rastro ──────────────────────────────────────────────────────
  /**
   * O que uma pessoa fez, e o que o servidor respondeu.
   *
   * Irmã do /admin/fila acima, e pela mesma razão: quando alguém relata um
   * problema, a pergunta é sempre "o que aconteceu com ESTA conta ontem à
   * noite", e ler o código não responde isso. O /admin/fila responde para
   * barcos; este responde para tudo.
   *
   * Sem `?email=`, mostra as falhas recentes do app inteiro — que é a outra
   * pergunta útil: "o que está quebrando agora, e para quantas pessoas".
   *
   * Só entra escrita (o que muda estado) e falha (o que a pessoa viu dar
   * errado). GET que deu certo não é registrado — ver services/rastro.ts.
   */
  app.get<{ Querystring: { email?: string; limite?: string; so_erros?: string } }>(
    '/admin/rastro',
    async (req, reply) => {
      const email = (req.query.email ?? '').trim().toLowerCase();
      const limite = Math.min(200, parseInt(req.query.limite ?? '60', 10));
      const soErros = req.query.so_erros === '1';

      if (!email) {
        // Sem conta: o painel de saúde. As falhas de todo mundo, mais recentes
        // primeiro, com o e-mail de quem bateu — para dizer se é um problema
        // de uma pessoa ou de todas.
        const { rows } = await pool.query(
          `SELECT r.at, r.method, r.path, r.status, r.ms, r.erro, r.req_id,
                  u.email
             FROM request_log r
             LEFT JOIN users u ON u.id = r.user_id
            WHERE r.status >= 400
            ORDER BY r.at DESC
            LIMIT $1`,
          [limite],
        );
        // O resumo é o que se lê primeiro: mesma rota falhando 40 vezes é
        // outra história de 40 rotas falhando uma vez cada.
        const { rows: resumo } = await pool.query(
          `SELECT path, status, erro, COUNT(*)::int AS vezes,
                  COUNT(DISTINCT user_id)::int AS pessoas,
                  MAX(at) AS ultima
             FROM request_log
            WHERE status >= 400 AND at > NOW() - INTERVAL '24 hours'
            GROUP BY path, status, erro
            ORDER BY vezes DESC
            LIMIT 20`,
        );
        return reply.send({ escopo: 'falhas recentes', resumo, linhas: rows });
      }

      const { rows: quem } = await pool.query(
        `SELECT id, email, country_code, lang, ban_status, receiving_paused,
                deleted_at, last_active_at, created_at
           FROM users WHERE LOWER(email) = $1`,
        [email],
      );
      if (!quem.length) return reply.code(404).send({ error: 'usuário não encontrado' });

      const { rows } = await pool.query(
        `SELECT at, method, path, status, ms, erro, req_id
           FROM request_log
          WHERE user_id = $1
            AND ($2::bool = false OR status >= 400)
          ORDER BY at DESC
          LIMIT $3`,
        [quem[0].id, soErros, limite],
      );

      return reply.send({ usuario: quem[0], linhas: rows });
    },
  );

  // ── GET /admin/countries ───────────────────────────────────────────────────
  // Lista dos 195 países participantes (barcos só "carimbam" países ativos)
  app.get('/admin/countries', async (_req, reply) => {
    const { rows } = await pool.query(
      `SELECT code, name_pt, name_en, active FROM countries ORDER BY name_pt`,
    );
    return reply.send({ countries: rows });
  });

  // ── PATCH /admin/countries/:code ───────────────────────────────────────────
  app.patch<{ Params: { code: string }; Body: { active: boolean } }>(
    '/admin/countries/:code',
    { schema: { body: { type: 'object', required: ['active'], properties: {
      active: { type: 'boolean' },
    } } } },
    async (req, reply) => {
      const { rowCount } = await pool.query(
        `UPDATE countries SET active = $1 WHERE code = $2`,
        [req.body.active, req.params.code.toUpperCase()],
      );
      if (!rowCount) return reply.code(404).send({ error: 'país não encontrado' });
      return reply.send({ status: 'ok' });
    },
  );

  // ── GET /admin/boats/:id ───────────────────────────────────────────────────
  // Caminho completo (lista de pulos) + mensagens do barco
  app.get<{ Params: { id: string } }>(
    '/admin/boats/:id',
    async (req, reply) => {
      const { rows: boatRows } = await pool.query(
        `SELECT b.id, b.status, b.stage, b.unique_countries, b.created_at,
                b.last_hop_at, u.email AS creator_email
         FROM boats b JOIN users u ON u.id = b.creator_user_id
         WHERE b.id = $1`,
        [req.params.id],
      );
      if (!boatRows.length) return reply.code(404).send({ error: 'barco não encontrado' });

      const { rows: hops } = await pool.query(
        `SELECT
           h.id, h.country_code, h.hopped_at,
           c.name_pt   AS country_name,
           bm.content  AS message,
           mu.email    AS author_email
         FROM boat_hops h
         LEFT JOIN countries     c  ON c.code = h.country_code
         LEFT JOIN boat_messages bm ON bm.id  = h.message_id
         LEFT JOIN users         mu ON mu.id  = h.to_user_id
         WHERE h.boat_id = $1
         ORDER BY h.hopped_at ASC`,
        [req.params.id],
      );

      // Lançamento = ponto 1 (mesma convenção da rota /boats/:id/route)
      const { rows: fm } = await pool.query(
        `SELECT bm.country_code, bm.content, c.name_pt
         FROM boat_messages bm
         LEFT JOIN countries c ON c.code = bm.country_code
         WHERE bm.boat_id = $1 ORDER BY bm.created_at ASC LIMIT 1`,
        [req.params.id],
      );
      if (fm.length) {
        hops.unshift({
          id: `launch-${req.params.id}`,
          country_code: fm[0].country_code,
          country_name: fm[0].name_pt,
          hopped_at: boatRows[0].created_at,
          message: fm[0].content,
          author_email: boatRows[0].creator_email,
        });
      }

      return reply.send({ boat: boatRows[0], hops });
    },
  );

  // ── POST /admin/espiar/:id ─────────────────────────────────────────────────
  /**
   * Entrar na visão de um usuário. SOMENTE LEITURA.
   *
   * Por que não existe "senha mestra": ela seria um segundo segredo que abre
   * todas as contas, teria que trafegar a cada uso e — o pior — não diz QUEM a
   * usou. Aqui a credencial é a mesma do painel, que já é do administrador; o
   * que sai daqui é um token curto, marcado e registrado.
   *
   * Três coisas separam este token de um login normal:
   *
   *   `espiando: true`   o preHandler em index.ts recusa qualquer método que
   *                      não seja GET. Esconder botão na tela não é leitura;
   *                      leitura é o servidor recusar a escrita.
   *   sem `role`         mesmo espiando a conta de outro administrador, o
   *                      painel continua fechado — não dá para escalar por aqui.
   *   `expiresIn: 30m`   nenhum outro token do Adrift expira (achado 3 da
   *                      auditoria). Este precisa: chave que abre conta alheia
   *                      e vale para sempre é a pior versão daquele bug.
   */
  app.post<{ Params: { id: string } }>(
    '/admin/espiar/:id',
    async (req, reply) => {
      const adminId = (req as any).user?.id;
      const alvo = req.params.id;

      const { rows } = await pool.query(
        `SELECT id, email, country_code FROM users WHERE id = $1`,
        [alvo],
      );
      if (!rows.length) return reply.code(404).send({ error: 'usuário não encontrado' });
      const u = rows[0];

      // O registro vem ANTES do token: se gravar falhar, ninguém entra. Espiada
      // sem rastro é justamente o que este desenho não quer permitir.
      await pool.query(
        `INSERT INTO impersonation_log (admin_id, target_id, target_email, ip)
         VALUES ($1, $2, $3, $4)`,
        [adminId, u.id, u.email, req.ip],
      );

      const token = app.jwt.sign(
        { id: u.id, email: u.email, country: u.country_code, espiando: true, porAdmin: adminId },
        { expiresIn: '30m' },
      );

      console.log(`[espiada] admin ${adminId} entrou na visão de ${u.email}`);
      return reply.send({
        token,
        user: { id: u.id, email: u.email, country: u.country_code },
        expiraEmSeg: 30 * 60,
      });
    },
  );

  // ── GET /admin/espiadas ────────────────────────────────────────────────────
  // O histórico, legível pelo próprio painel: de nada adianta registrar se
  // ninguém consegue ler depois.
  app.get<{ Querystring: { limit?: string } }>(
    '/admin/espiadas',
    async (req, reply) => {
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10) || 50, 200);
      const { rows } = await pool.query(
        `SELECT l.created_at, l.target_email, l.ip, a.email AS admin_email
           FROM impersonation_log l
           JOIN users a ON a.id = l.admin_id
          ORDER BY l.created_at DESC
          LIMIT $1`,
        [limit],
      );
      return reply.send({ espiadas: rows });
    },
  );
}
