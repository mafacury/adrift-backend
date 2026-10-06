import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool, emTransacao } from '../db/pool.js';
import { processModeration, processRouting } from '../services/process.js';
import { countryFromIp } from '../services/geo.js';
import { userOwnsGift, giftInfo, consumeGift } from '../services/gifts.js';
import { liveStateFrom } from '../services/live.js';
import { greatCirclePoint, legProgress } from '../services/horizon.js';
import { STAGE_CASE_SQL } from '../services/progress.js';
import { startReturn, MIN_COUNTRIES_TO_RETURN } from '../services/journey.js';
import { boatGiftMessage } from '../services/push.js';
import { avisar } from '../services/notify.js';
import { config } from '../config/index.js';
import { traduzirMensagens } from '../services/translate.js';
import { premiarIndicacao } from '../services/indicacao.js';
import { idiomaDoUsuario, tr } from '../services/i18n.js';
import { semBloqueioEntre } from '../services/bloqueio.js';

interface CreateBoatBody {
  content: string;
  giftId?: string;
  /** A caixa "permito que minha mensagem seja publicada". Ver migração 043. */
  publicavel?: boolean;
}

interface HopBody {
  content?: string;
  giftId?: string;
  publicavel?: boolean;
}

export async function boatRoutes(app: FastifyInstance) {
  // ── POST /boats ────────────────────────────────────────────────────────────
  /**
   * O tamanho da mensagem, contado como gente conta.
   *
   * `.length` do JavaScript conta unidades UTF-16: um emoji vale 2, e uma
   * letra acentuada pode valer 2. Espalhar `[...texto]` conta CARACTERES de
   * verdade, que é o que a pessoa vê e o que a mensagem de erro promete.
   *
   * O `minLength` do schema não serve para isto: conta as mesmas unidades
   * UTF-16 e não sabe tirar espaço em branco — " a " passaria por três.
   */
  const tamanho = (texto: string) => [...texto].length;

  /** A recusa, na língua de quem escreveu. */
  async function curtaDemais(userId: string, reply: FastifyReply) {
    const lang = await idiomaDoUsuario(userId);
    return reply.code(400).send({
      error: 'mensagem_curta',
      message: tr(
        lang,
        'Escreva um pouco mais: uma mensagem precisa de pelo menos {n} caracteres.',
        { n: config.antispam.minMensagem },
      ),
      minLength: config.antispam.minMensagem,
    });
  }

  app.post<{ Body: CreateBoatBody }>(
    '/boats',
    { schema: { body: { type: 'object', required: ['content'], properties: {
      content: { type: 'string', minLength: 1, maxLength: 500 },
      giftId:  { type: 'string', maxLength: 40 },
      publicavel: { type: 'boolean' },
    } } } },
    async (req: FastifyRequest<{ Body: CreateBoatBody }>, reply: FastifyReply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const { content, giftId } = req.body;
      // Três estados (ver migração 043). Ausente — o site antigo, ainda sem a
      // caixa — vira NULL: a pessoa não foi perguntada. Para a página pública
      // só o TRUE é licença; o NULL do dono mantém o que ela sempre mostrou.
      const publicavel = typeof req.body.publicavel === 'boolean' ? req.body.publicavel : null;

      // O que se guarda é o texto TRIMADO, não o que chegou: espaço em volta
      // não é mensagem, e era ele que fazia " a " valer três caracteres.
      const texto = (content ?? '').trim();
      if (tamanho(texto) < config.antispam.minMensagem) return curtaDemais(userId, reply);

      // ── Freio de lançamento ────────────────────────────────────────────────
      // Não existia teto nenhum: uma conta lançava barcos até cansar, e uma
      // fábrica de contas multiplicava isso. Dois limites, ambos folgados para
      // quem usa o app de verdade e ruinosos para quem despeja propaganda.
      const { rows: freio } = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM boats
             WHERE creator_user_id = $1 AND status = 'active')          AS ativos,
           (SELECT MAX(created_at) FROM boats
             WHERE creator_user_id = $1)                                AS ultimo`,
        [userId],
      );
      const ativos: number = freio[0]?.ativos ?? 0;
      const ultimo: Date | null = freio[0]?.ultimo ?? null;

      if (ativos >= config.antispam.maxActiveBoatsPerUser) {
        const lang = await idiomaDoUsuario(userId);
        return reply.code(429).send({
          error: 'limite_de_barcos',
          message: tr(lang,
            'Você já tem {n} barcos no mar. Espere um deles voltar para casa antes de lançar outro.',
            { n: ativos }),
        });
      }

      if (ultimo) {
        const esperaSeg = config.antispam.launchCooldownSec;
        const decorrido = (Date.now() - new Date(ultimo).getTime()) / 1000;
        if (decorrido < esperaSeg) {
          const faltam = Math.ceil(esperaSeg - decorrido);
          const lang = await idiomaDoUsuario(userId);
          return reply.code(429).send({
            error: 'aguarde',
            message: faltam >= 60
              ? tr(lang, 'Um barco de cada vez. Espere {n} minuto(s) para lançar o próximo.', { n: Math.ceil(faltam / 60) })
              : tr(lang, 'Um barco de cada vez. Espere {n} segundos para lançar o próximo.', { n: faltam }),
            retryAfterSec: faltam,
          });
        }
      }

      // Usa o país do JWT (detectado no login) ou faz fallback para IP atual
      const countryCode = (req as any).user?.country || await countryFromIp(req.ip);

      // valida o presente (se houver) — só o que o usuário destravou
      const gift = giftId && (await userOwnsGift(userId, giftId)) ? giftId : null;
      // sai do bau agora: presente que nao gasta nada nao vale nada
      if (gift) await consumeGift(userId, gift);

      // Leitura antes da transação: feita lá dentro pelo `pool`, iria por outra
      // conexão — não enxergaria o que a transação ainda não confirmou e
      // poderia ficar esperando uma trava que a própria transação segura.
      const idiomaDeQuemEscreve = await idiomaDoUsuario(userId);

      // O barco e a primeira mensagem nascem juntos ou não nascem: um barco
      // sem a mensagem que o motivou é um barco vazio navegando o mundo, e não
      // há como descobrir depois o que ele deveria estar carregando.
      //
      // Era `pool.query('BEGIN; SELECT 1')`, que abria a transação numa conexão
      // e a devolvia ao pool ainda aberta — ver `emTransacao` em db/pool.ts.
      const { boatId, messageId } = await emTransacao(async (c) => {
        const boatResult = await c.query(
          `INSERT INTO boats (creator_user_id) VALUES ($1) RETURNING id`,
          [userId],
        );
        const novoBarco: string = boatResult.rows[0].id;

        const msgResult = await c.query(
          `INSERT INTO boat_messages (boat_id, user_id, content, country_code, gift_id, lang, publicavel)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [novoBarco, userId, texto, countryCode, gift, idiomaDeQuemEscreve, publicavel],
        );
        return { boatId: novoBarco, messageId: msgResult.rows[0].id as string };
      });

      // Moderação roda em background — resposta não espera
      void processModeration({ boatId, messageId, content: texto, userId, countryCode });

      // Se esta pessoa veio pelo convite de alguém, é AQUI que quem a trouxe
      // recebe o prêmio — no primeiro barco, não no cadastro. Cadastro é
      // barato de fabricar; lançar um barco exige e-mail confirmado, captcha,
      // país e algo escrito. Sem await: prêmio não pode atrasar o lançamento.
      void premiarIndicacao(userId);

      return reply.code(202).send({
        boatId,
        status: 'pending_moderation',
        message: 'Barcos viajam pelo oceano. Chegam quando chegam.',
      });
    },
  );

  // ── POST /boats/:id/hop ────────────────────────────────────────────────────
  // Receptor adds message (optional) and sends boat onward
  app.post<{ Params: { id: string }; Body: HopBody }>(
    '/boats/:id/hop',
    { schema: { body: { type: 'object', properties: {
      content: { type: 'string', minLength: 1, maxLength: 500 },
      giftId:  { type: 'string', maxLength: 40 },
      publicavel: { type: 'boolean' },
    } } } },
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const boatId = req.params.id;
      const { content, giftId } = req.body ?? {};
      const publicavel = typeof req.body?.publicavel === 'boolean' ? req.body.publicavel : null;
      const ip = req.ip;
      const countryCode = await countryFromIp(ip);

      // Aqui escrever é OPCIONAL — deixar o barco passar sem responder é um
      // caminho legítimo do produto. A regra, então, é: ou nada, ou uma
      // mensagem de verdade. O `texto` também fecha um caso silencioso: só
      // espaços era "conteúdo" para o `if` mais abaixo, e nascia uma mensagem
      // em branco dentro do barco.
      const texto = (content ?? '').trim();
      if (texto && tamanho(texto) < config.antispam.minMensagem) {
        return curtaDemais(userId, reply);
      }

      // Verify the boat exists and is active, and this user has a pending queue entry
      const { rows: queueRows } = await pool.query(
        `SELECT id FROM receiver_queue
         WHERE boat_id = $1 AND user_id = $2 AND status = 'pending'
         LIMIT 1`,
        [boatId, userId],
      );
      if (!queueRows.length) {
        return reply.code(404).send({ error: 'boat not in your queue' });
      }

      // presente só é anexado a uma mensagem — e só se o usuário o tiver.
      // DEPOIS da conferência da fila: antes o presente saía do baú e só então
      // a rota descobria que o barco já tinha ido embora (o 404 acima), e o
      // presente sumia sem ter viajado.
      const gift = texto && giftId && (await userOwnsGift(userId, giftId)) ? giftId : null;
      if (gift) await consumeGift(userId, gift);

      // O idioma sai de dentro da transação de propósito: é leitura, e leitura
      // feita por `pool` lá dentro iria por OUTRA conexão — não enxergaria o
      // que a transação ainda não confirmou, e no pior caso ficaria esperando
      // uma trava que a própria transação segura. Ler antes resolve os dois.
      const idiomaDeQuemEscreve = texto ? await idiomaDoUsuario(userId) : null;

      // Transação de verdade — ver `emTransacao` em db/pool.ts. Aqui é a
      // resposta de alguém a um barco: a fila muda de estado, a mensagem
      // nasce, o pulo é gravado e o estágio recalculado. Metade disso é um
      // barco que a pessoa respondeu sem a resposta existir.
      let messageId: string | null = null;
      await emTransacao(async (c) => {
        // Mark queue entry delivered
        await c.query(
          `UPDATE receiver_queue SET status = 'delivered'
           WHERE boat_id = $1 AND user_id = $2 AND status = 'pending'`,
          [boatId, userId],
        );

        if (texto) {
          const msgResult = await c.query(
            `INSERT INTO boat_messages (boat_id, user_id, content, country_code, gift_id, lang, publicavel)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [boatId, userId, texto, countryCode, gift, idiomaDeQuemEscreve, publicavel],
          );
          messageId = msgResult.rows[0].id;
          // conteúdo novo = assunto vivo: zera o contador de "deixaram passar"
          await c.query(`UPDATE boats SET idle_ignores = 0 WHERE id = $1`, [boatId]);
        }

        // Record hop immediately (receptor interacted — boat is "here" now)
        const { rows: prevHop } = await c.query(
          `SELECT to_user_id FROM boat_hops WHERE boat_id = $1 ORDER BY hopped_at DESC LIMIT 1`,
          [boatId],
        );
        const fromUserId = prevHop[0]?.to_user_id ?? null;

        // Insert hop
        await c.query(
          `INSERT INTO boat_hops (boat_id, from_user_id, to_user_id, country_code, message_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [boatId, fromUserId, userId, countryCode, messageId],
        );

        // Update boat_countries + stage
        await c.query(
          `INSERT INTO boat_countries (boat_id, country_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [boatId, countryCode],
        );
        if (messageId) {
          await c.query(
            `INSERT INTO boat_country_interactions (boat_id, country_code, user_id)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [boatId, countryCode, userId],
          );
        }
        await c.query(
          `UPDATE boats
           SET
             unique_countries = (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1),
             stage = ${STAGE_CASE_SQL},
             last_hop_at = NOW()
           WHERE id = $1`,
          [boatId],
        );

      });

      // Daqui para baixo a transação já foi confirmada. Nada abaixo desta
      // linha pode ser desfeito, e é por isso que só há avisos e trabalho de
      // fundo: o que precisava ser atômico ficou lá dentro.
      if (gift) {
        const { rows: cr } = await pool.query(
          `SELECT creator_user_id FROM boats WHERE id = $1`, [boatId],
        );
        const creatorId = cr[0]?.creator_user_id;
        if (creatorId && creatorId !== userId) {
          const msg = boatGiftMessage(await idiomaDoUsuario(creatorId));
          void avisar(creatorId, { titulo: msg.title, corpo: msg.body, url: '/map', tag: 'presente' });
        }
      }

      if (texto && messageId) {
        // Nova mensagem — modera antes de rotear (em background)
        void processModeration({ boatId, messageId, content: texto, userId, countryCode });
      } else {
        // Sem mensagem nova — rotear direto (em background)
        void processRouting({ boatId, fromUserId: userId });
      }

      return reply.send({ status: 'sailing' });
    },
  );

  // ── POST /boats/:id/imagem ─────────────────────────────────────────────────
  // O cartão do link compartilhado: o mapa com a rota, desenhado no navegador
  // do dono (mesmo pergaminho, mesma projeção do Mapa) e guardado aqui para a
  // página /j/:id oferecer como og:image. Só o dono grava, e só JPEG — o teto
  // e a assinatura do arquivo são o que impede usar esta rota como depósito.
  app.post<{ Params: { id: string }; Body: { jpeg: string } }>(
    '/boats/:id/imagem',
    { schema: { body: { type: 'object', required: ['jpeg'], properties: {
      // ~600 KB de JPEG em base64. O desenho de 1200×630 fica em 100–250 KB.
      jpeg: { type: 'string', maxLength: 820_000 },
    } } } },
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const boatId = req.params.id;
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID.test(boatId)) return reply.code(404).send({ error: 'not_found' });

      const { rows } = await pool.query(
        `SELECT 1 FROM boats WHERE id = $1 AND creator_user_id = $2`, [boatId, userId],
      );
      if (!rows.length) return reply.code(404).send({ error: 'not_found' });

      const bytes = Buffer.from(req.body.jpeg.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
      const ehJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      if (!ehJpeg || bytes.length > 600_000) {
        return reply.code(400).send({ error: 'imagem_invalida' });
      }

      await pool.query(
        `INSERT INTO boat_share_images (boat_id, jpeg, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (boat_id) DO UPDATE SET jpeg = EXCLUDED.jpeg, updated_at = NOW()`,
        [boatId, bytes],
      );
      return reply.send({ ok: true });
    },
  );

  // ── POST /boats/:id/translate ──────────────────────────────────────────────
  // Traduz as mensagens do barco para o português. Só a pedido: as mensagens
  // chegam em japonês, italiano, suaíli, e quem recebe quer entender antes de
  // responder — mas o original é a mensagem, e ele nunca é substituído sem que
  // a pessoa peça.
  app.post<{ Params: { id: string } }>(
    '/boats/:id/translate',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      // Só quem tem alguma ligação com este barco pode pedir a tradução dele —
      // senão bastaria adivinhar um id para ler o barco de outra pessoa.
      // São três os vínculos legítimos, e o primeiro é o mais óbvio de esquecer:
      // o DONO não tem linha na fila de recebimento do próprio barco, então a
      // versão anterior recusava traduzir o barco de quem o lançou.
      const { rows: pode } = await pool.query(
        `SELECT 1 WHERE
           EXISTS (SELECT 1 FROM boats
                    WHERE id = $1 AND creator_user_id = $2)
           OR EXISTS (SELECT 1 FROM receiver_queue
                       WHERE boat_id = $1 AND user_id = $2)
           OR EXISTS (SELECT 1 FROM boat_messages
                       WHERE boat_id = $1 AND user_id = $2)`,
        [req.params.id, userId],
      );
      if (pode.length === 0) return reply.code(404).send({ error: 'not_found' });

      // MESMA ordem da fila (created_at DESC): é o índice que liga cada
      // tradução à mensagem na tela
      const { rows: msgs } = await pool.query(
        `SELECT content, lang FROM boat_messages
          WHERE boat_id = $1
          ORDER BY created_at DESC`,
        [req.params.id],
      );

      // Para o idioma de QUEM LÊ, não para português. O cache já era indexado
      // por idioma; o que faltava era a instrução saber disso.
      const traducoes = await traduzirMensagens(
        msgs.map(m => ({ texto: m.content as string, lang: m.lang as string | null })),
        await idiomaDoUsuario(userId),
      );
      return reply.send({ translations: traducoes });
    },
  );

  // ── POST /boats/:id/ignore ─────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/boats/:id/ignore',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const boatId = req.params.id;

      // Transação de verdade — ver `emTransacao` em db/pool.ts. Os três
      // passos são a mesma decisão: a pessoa deixou passar. Gravar o "passou"
      // sem somar o contador faria o barco nunca voltar para casa.
      await emTransacao(async (c) => {
        // Mark queue entry skipped
        await c.query(
          `UPDATE receiver_queue SET status = 'skipped'
           WHERE boat_id = $1 AND user_id = $2 AND status = 'pending'`,
          [boatId, userId],
        );

        // Upsert ignore count
        await c.query(
          `INSERT INTO boat_ignore_counts (boat_id, user_id, count)
           VALUES ($1, $2, 1)
           ON CONFLICT (boat_id, user_id) DO UPDATE SET count = boat_ignore_counts.count + 1`,
          [boatId, userId],
        );

        // "Deixaram passar" SEGUIDOS — o sinal de que o assunto se esgotou.
        // Qualquer mensagem nova zera; chegando a MAX_IDLE_IGNORES o barco
        // volta para casa (services/journey.ts).
        await c.query(
          `UPDATE boats SET idle_ignores = idle_ignores + 1 WHERE id = $1`,
          [boatId],
        );
      });

      // Re-route to someone else (em background)
      void processRouting({ boatId, fromUserId: null });

      return reply.send({ status: 'ignored' });
    },
  );

  // ── POST /boats/:id/return ─────────────────────────────────────────────────
  // "Chamar de volta": encerra a jornada por escolha do dono. O barco para de
  // receber mensagens na hora e navega de volta em TEMPO REAL (1 a 5 dias,
  // pela distância). Não dá para cancelar — é isso que dá peso à decisão.
  app.post<{ Params: { id: string } }>(
    '/boats/:id/return',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const { rows } = await pool.query(
        `SELECT creator_user_id, status, unique_countries FROM boats WHERE id = $1`,
        [req.params.id],
      );
      if (!rows.length) return reply.code(404).send({ error: 'boat not found' });
      const boat = rows[0];

      if (boat.creator_user_id !== userId) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      if (boat.status === 'returning') {
        return reply.code(409).send({ error: 'already_returning' });
      }
      if (boat.status !== 'active') {
        return reply.code(409).send({ error: 'not_active' });
      }
      if (boat.unique_countries < MIN_COUNTRIES_TO_RETURN) {
        return reply.code(409).send({
          error: 'too_early',
          minCountries: MIN_COUNTRIES_TO_RETURN,
        });
      }

      const { arrivesHomeAt } = await startReturn(req.params.id, 'chamado');
      return reply.send({ status: 'returning', arrives_home_at: arrivesHomeAt });
    },
  );

  // ── POST /boats/:id/final-note ─────────────────────────────────────────────
  // A última página do diário: a despedida que o dono escreve quando o barco
  // atraca. Opcional — a jornada começou com uma mensagem dele e termina com
  // uma mensagem dele.
  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/boats/:id/final-note',
    {
      schema: {
        body: {
          type: 'object',
          properties: { note: { type: 'string', maxLength: 500 } },
        },
      },
    },
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const note = (req.body?.note ?? '').trim();
      const { rowCount } = await pool.query(
        `UPDATE boats SET final_note = $3
         WHERE id = $1 AND creator_user_id = $2 AND status = 'archived'`,
        [req.params.id, userId, note || null],
      );
      if (!rowCount) return reply.code(404).send({ error: 'boat not found' });
      return reply.send({ status: 'ok' });
    },
  );

  // ── POST /boats/:id/typing ─────────────────────────────────────────────────
  // Receptor humano avisa que está digitando a resposta — o criador do barco
  // vê "escrevendo..." ao vivo no mapa. O app manda o sinal a cada ~10 s.
  app.post<{ Params: { id: string } }>(
    '/boats/:id/typing',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      await pool.query(
        `UPDATE receiver_queue SET typing_at = NOW()
         WHERE boat_id = $1 AND user_id = $2 AND status = 'pending'`,
        [req.params.id, userId],
      );
      return reply.send({ status: 'ok' });
    },
  );

  // ── GET /boats/:id/route ───────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/boats/:id/route',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const boatId = req.params.id;

      // Only the creator can see the full route
      const { rows: boatRows } = await pool.query(
        `SELECT id, creator_user_id, status, stage, unique_countries, created_at, last_hop_at,
                returning_at, arrives_home_at, archived_at, archive_reason,
                final_note, total_nm,
                unique_countries >= ${MIN_COUNTRIES_TO_RETURN} AS can_return
         FROM boats WHERE id = $1`,
        [boatId],
      );
      if (!boatRows.length) return reply.code(404).send({ error: 'boat not found' });
      const boat = boatRows[0];
      if (boat.creator_user_id !== userId) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      // O lançamento é o "ponto 1" da jornada: país e mensagem inicial do
      // criador entram como primeiro item, antes dos pulos reais — assim o
      // barco aparece no mapa desde o momento em que é lançado.
      const { rows: firstMsg } = await pool.query(
        `SELECT country_code, content, gift_id FROM boat_messages
         WHERE boat_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [boatId],
      );

      // Hop history with messages
      const { rows: hops } = await pool.query(
        `SELECT
           h.id,
           h.country_code,
           h.hopped_at,
           -- O id da MENSAGEM, que não é o do pulo. Sem ele o Mapa mostrava o
           -- que estranhos escreveram no barco da pessoa sem nenhum caminho
           -- para denunciar: POST /boats/:id/report pede o messageId, e a tela
           -- não tinha como dizer QUAL mensagem.
           bm.id AS message_id,
           bm.content AS message,
           bm.gift_id,
           -- O porto escreveu, mas quem escreveu está bloqueado — o LEFT JOIN
           -- acima derrubou a linha. Sem este aviso a tela mostraria "passou
           -- sem escrever", que é mentira: o app estaria contando uma história
           -- diferente da que aconteceu, e por decisão da própria pessoa.
           (h.message_id IS NOT NULL AND bm.id IS NULL) AS bloqueada,
           bci.interaction_count
         FROM boat_hops h
         -- No JOIN, não no WHERE: o porto continua existindo na história do
         -- barco (e na numeração dos pinos do mapa), só que calado. Tirar a
         -- LINHA faria a rota do barco encolher, e ela é o registro da viagem.
         LEFT JOIN boat_messages bm
                ON bm.id = h.message_id
               AND ${semBloqueioEntre('$2', 'bm.user_id')}
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS interaction_count
           FROM boat_country_interactions
           WHERE boat_id = $1 AND country_code = h.country_code
         ) bci ON TRUE
         WHERE h.boat_id = $1
         ORDER BY h.hopped_at ASC`,
        [boatId, userId],
      );

      if (firstMsg.length) {
        hops.unshift({
          id: `launch-${boatId}`,
          country_code: firstMsg[0].country_code,
          hopped_at: boat.created_at,
          // sem `message_id` de propósito: este porto é a mensagem do PRÓPRIO
          // dono do barco, e ninguém denuncia nem bloqueia a si mesmo
          message_id: null,
          bloqueada: false,
          message: firstMsg[0].content,
          gift_id: firstMsg[0].gift_id,
          interaction_count: 0,
        });
      }

      // Estado "ao vivo" (ver services/live.ts): humanos = sinal real de
      // digitação; bots = prazo determinístico. Não revela país nem horário.
      const { rows: liveRows } = await pool.query(
        `SELECT
           (u.oauth_provider = 'bot') AS is_bot,
           rq.typing_at,
           rq.arrives_at,
           rq.queued_at,
           -- pontas da travessia, só para calcular ONDE ele está agora;
           -- o destino não sai daqui (ver o objeto leg montado abaixo)
           COALESCE(oh.lat, om.lat) AS o_lat,
           COALESCE(oh.lon, om.lon) AS o_lon,
           dc.lat AS d_lat,
           dc.lon AS d_lon,
           -- prazo efetivo do bot: chegada + leitura (5..45min) OU pouco
           -- antes de a fila expirar — o que vier primeiro
           LEAST(
             rq.arrives_at + ((5 + ABS(HASHTEXT(rq.id::text)) % 41) || ' minutes')::interval,
             rq.expires_at - INTERVAL '2 minutes'
           ) AS responds_at
         FROM receiver_queue rq
         JOIN users u ON u.id = rq.user_id
         LEFT JOIN countries dc ON dc.code = COALESCE(rq.dest_country, u.country_code)
         -- porto de partida: o último pulo antes de zarpar
         LEFT JOIN LATERAL (
           SELECT c.lat, c.lon
           FROM boat_hops h JOIN countries c ON c.code = h.country_code
           WHERE h.boat_id = rq.boat_id AND h.hopped_at <= rq.queued_at
           ORDER BY h.hopped_at DESC LIMIT 1
         ) oh ON TRUE
         -- barco que ainda não pulou: parte de onde foi lançado
         LEFT JOIN LATERAL (
           SELECT c.lat, c.lon
           FROM boat_messages m JOIN countries c ON c.code = m.country_code
           WHERE m.boat_id = rq.boat_id
           ORDER BY m.created_at ASC LIMIT 1
         ) om ON TRUE
         WHERE rq.boat_id = $1 AND rq.status = 'pending'
         ORDER BY rq.queued_at DESC
         LIMIT 1`,
        [boatId],
      );

      // Resolve o código do presente no catálogo (nome + emoji) para o painel
      // do mapa mostrar o presente AO LADO da mensagem em que foi deixado.
      const hopsWithGifts = hops.map(({ gift_id, ...h }) => ({
        ...h,
        gift: giftInfo(gift_id ?? null),
      }));

      // Onde o barco está AGORA. Serve para o mapa desenhar a travessia se
      // preenchendo em vez de deixar o barco parado no porto por horas.
      //
      // DURANTE a travessia sai a posição e o relógio, nunca o destino: quem
      // recebe é surpresa, e a linha some na bruma adiante do casco. Nem a
      // FRAÇÃO sai — com a partida (que é pública), a posição e a fração, uma
      // regra de três devolveria o ponto de chegada.
      //
      // DEPOIS de atracar, o barco fica no porto de destino, e aí o país sai
      // sim. Antes ele não saía, e o mapa fazia coisa pior que revelar: sem
      // posição, o desenho caía no último pulo — o porto de ONDE ELE PARTIU. O
      // barco voltava várias paradas para trás no instante em que chegava,
      // ficava lá enquanto alguém escrevia, e só então saltava para o porto
      // novo. Mostrava um lugar errado para esconder o certo.
      //
      // O sigilo que se perde aqui é de minutos: assim que a pessoa devolve o
      // barco, o pulo aparece com o país — e mesmo quando ela não escreve
      // nada, o porto entra na lista como "passou sem escrever", com bandeira.
      const lr = liveRows[0];
      let leg: { lat: number; lon: number; etaSeconds: number; atracado?: boolean } | null = null;
      if (lr?.o_lat != null && lr?.d_lat != null && lr?.arrives_at) {
        const startedMs = new Date(lr.queued_at).getTime();
        const arrivesMs = new Date(lr.arrives_at).getTime();
        const now = Date.now();
        if (arrivesMs > now) {
          const f = legProgress(startedMs, arrivesMs, now);
          const p = greatCirclePoint(
            Number(lr.o_lat), Number(lr.o_lon), Number(lr.d_lat), Number(lr.d_lon), f,
          );
          leg = {
            lat: Math.round(p.lat * 100) / 100,
            lon: Math.round(p.lon * 100) / 100,
            etaSeconds: Math.round((arrivesMs - now) / 1000),
          };
        } else {
          // chegou: o casco fica no destino até virar pulo
          leg = {
            lat: Math.round(Number(lr.d_lat) * 100) / 100,
            lon: Math.round(Number(lr.d_lon) * 100) / 100,
            etaSeconds: 0,
            atracado: true,
          };
        }
      }

      return reply.send({
        boat, hops: hopsWithGifts,
        live: { state: liveStateFrom(liveRows[0], boat.status) },
        leg,
      });
    },
  );

  // ── GET /rankings ──────────────────────────────────────────────────────────
  // Ranking de BARCOS (anônimo): pontos = interações (mensagens de terceiros)
  // + presentes recebidos × 10.
  //   scope=semana   — MARÉ DA SEMANA: só o que chegou desde segunda-feira
  //                    (00h UTC). Recomeça toda semana, e é por isso que
  //                    existe: no ranking de sempre o topo é de barcos com
  //                    meses de viagem e 500 mensagens, e quem chegou ontem
  //                    nunca vai aparecer. Aqui todo mundo começa do zero.
  //   scope=world    — barcos em alto-mar (mundial)
  //   scope=country  — barcos em alto-mar do país do criador
  //   scope=legends  — LENDAS: hall da fama permanente dos arquivados. Assim
  //                    aposentar um barco bem colocado o PROMOVE para a lista
  //                    eterna em vez de apagá-lo.
  // Barcos de bots, de vitrine e de teste ficam de fora. Inclui a posição do
  // melhor barco do usuário logado, mesmo fora do Top 50.
  app.get<{ Querystring: { scope?: string } }>(
    '/rankings',
    {},
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const legends = req.query.scope === 'legends';
      const semana  = req.query.scope === 'semana';
      // Fragmentos derivados de lista fechada — nunca de entrada do usuário.
      const statusSql = legends
        ? `b.status = 'archived' AND COALESCE(b.archive_reason, 'perdido') NOT IN ('moderado', 'teste')`
        // 'paused' fica de fora: é barco denunciado ou em dúvida na moderação,
        // e o ranking mostra a primeira frase dele para todo mundo
        : `b.status IN ('active', 'returning')`;
      // na semana, só contam as mensagens desde a segunda-feira
      const janelaSql = semana ? `AND m.created_at >= date_trunc('week', NOW())` : '';
      // barco sem ponto na semana não entra: "50º lugar com 0 pontos" não é
      // lugar nenhum, e encheria a lista de barcos parados
      const soComPontos = semana ? 'WHERE score > 0' : '';

      let countryFilter: string | null = null;
      if (req.query.scope === 'country') {
        const { rows } = await pool.query(
          `SELECT country_code FROM users WHERE id = $1`, [userId],
        );
        countryFilter = rows[0]?.country_code ?? null;
      }

      const rankedSql = `
        WITH scored AS (
          SELECT
            b.id, b.stage, b.creator_user_id,
            b.archive_reason, b.total_nm, b.unique_countries,
            u.country_code,
            (SELECT LEFT(content, 60) FROM boat_messages
             WHERE boat_id = b.id ORDER BY created_at ASC LIMIT 1) AS initial_message,
            (SELECT COUNT(*)::int FROM boat_messages m
             WHERE m.boat_id = b.id AND m.user_id <> b.creator_user_id ${janelaSql}) AS interactions,
            (SELECT COUNT(*)::int FROM boat_messages m
             WHERE m.boat_id = b.id AND m.user_id <> b.creator_user_id
               AND m.gift_id IS NOT NULL ${janelaSql}) AS gifts
          FROM boats b
          JOIN users u ON u.id = b.creator_user_id
          WHERE u.oauth_provider IS DISTINCT FROM 'bot'
            AND NOT COALESCE(b.vitrine, FALSE)
            AND ${statusSql}
            AND ($1::text IS NULL OR u.country_code = $1)
        ),
        ranked AS (
          SELECT *,
            interactions + gifts * 10 AS score,
            RANK() OVER (ORDER BY interactions + gifts * 10 DESC) AS pos
          FROM scored
        )`;

      const { rows: top } = await pool.query(
        `${rankedSql}
         SELECT pos, id, stage, country_code, initial_message,
                interactions, gifts, score,
                archive_reason, total_nm, unique_countries,
                (creator_user_id = $2) AS is_mine
         FROM ranked
         ${soComPontos}
         ORDER BY pos, id
         LIMIT 50`,
        [countryFilter, userId],
      );

      const { rows: mine } = await pool.query(
        `${rankedSql}
         SELECT pos, id FROM ranked
         WHERE creator_user_id = $2 ${semana ? 'AND score > 0' : ''}
         ORDER BY pos LIMIT 1`,
        [countryFilter, userId],
      );

      // quando a maré vira: a próxima segunda-feira, 00h UTC
      let fimDaSemana: string | null = null;
      if (semana) {
        const { rows } = await pool.query(
          `SELECT date_trunc('week', NOW()) + INTERVAL '7 days' AS fim`,
        );
        fimDaSemana = new Date(rows[0].fim).toISOString();
      }

      return reply.send({
        scope: semana ? 'semana' : legends ? 'legends' : countryFilter ? 'country' : 'world',
        fim_da_semana: fimDaSemana,
        country: countryFilter,
        rows: top,
        me: mine[0] ?? null,
      });
    },
  );

  // ── POST /boats/:id/report ─────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: { messageId: string } }>(
    '/boats/:id/report',
    { schema: { body: { type: 'object', required: ['messageId'], properties: {
      messageId: { type: 'string' },
    } } } },
    async (req, reply) => {
      const userId = (req as any).user?.id;
      if (!userId) return reply.code(401).send({ error: 'unauthorized' });

      const boatId = req.params.id;
      const { messageId } = req.body;

      // A mensagem tem de ser DESTE barco, e quem denuncia tem de ter passado
      // por ele (recebeu, escreveu ou é o dono). Sem isto a contagem era por
      // mensagem e a pausa era pelo barco da URL: dava para juntar denúncias
      // numa mensagem qualquer e pausar um barco que ninguém viu. O formato
      // conferido antes evita que um id malformado vire erro 500 no banco.
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID.test(boatId) || !UUID.test(messageId)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const { rows: vinculo } = await pool.query(
        `SELECT 1 FROM boat_messages m
          WHERE m.id = $2 AND m.boat_id = $1
            AND m.user_id <> $3
            AND (   EXISTS (SELECT 1 FROM boats WHERE id = $1 AND creator_user_id = $3)
                 OR EXISTS (SELECT 1 FROM receiver_queue WHERE boat_id = $1 AND user_id = $3)
                 OR EXISTS (SELECT 1 FROM boat_messages WHERE boat_id = $1 AND user_id = $3))`,
        [boatId, messageId, userId],
      );
      if (!vinculo.length) return reply.code(404).send({ error: 'not_found' });

      await pool.query(
        `INSERT INTO reports (boat_id, message_id, reporter_user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [boatId, messageId, userId],
      );

      // Check if MIN_REPORTS_TO_PAUSE threshold reached
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS count FROM reports WHERE message_id = $1`,
        [messageId],
      );
      if (parseInt(rows[0].count, 10) >= config.boat.minReportsToPause) {
        await pool.query(
          `UPDATE boats SET status = 'paused' WHERE id = $1`,
          [boatId],
        );
      }

      return reply.send({ status: 'reported' });
    },
  );
}
