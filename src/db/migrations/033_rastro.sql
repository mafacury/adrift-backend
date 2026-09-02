-- 033 — rastro de requisições
--
-- Existe porque já aconteceu: alguém relatou que um barco sumiu, e eu li cinco
-- caminhos do código sem conseguir dizer o que tinha acontecido com AQUELE
-- barco. A resposta estava no dado, e não havia onde olhar o dado. O `/admin/fila`
-- resolveu aquele caso; esta tabela resolve a classe do caso.
--
-- O que ela NÃO guarda, de propósito:
--
--   o corpo da requisição   é lá que vive o texto das mensagens — o que
--                           estranhos escrevem uns aos outros — e a SENHA, que
--                           `DELETE /users/me` manda no corpo justamente para
--                           não cair no log do servidor. Guardar corpo aqui
--                           desfaria isso e contradiria os Termos, que dizem
--                           que o texto das mensagens não sai do Adrift.
--   o corpo da resposta     mesma coisa, pelo mesmo motivo.
--   o IP                    é dado pessoal que os Termos não mencionam, e para
--                           "fulano relatou um erro" a busca é por conta, não
--                           por IP. O Fastify continua registrando IP na saída
--                           padrão, que o Railway guarda por alguns dias — se
--                           um dia precisar, está lá.
--
-- O que ela guarda é a FORMA da conversa: quem, quando, qual rota, que método,
-- que resposta, em quanto tempo. Isso é o suficiente para reconstruir o que a
-- pessoa fez e o que o servidor respondeu, que é a pergunta do troubleshooting.
--
-- `req_id` é o mesmo identificador que o Fastify põe em cada linha da saída
-- padrão. É a ponte: achou a linha aqui, tem como achar o log completo do
-- Railway enquanto ele ainda existir.

CREATE TABLE IF NOT EXISTS request_log (
  id      BIGSERIAL PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  req_id  TEXT,
  method  TEXT     NOT NULL,
  path    TEXT     NOT NULL,
  status  SMALLINT NOT NULL,
  ms      INTEGER  NOT NULL,
  erro    TEXT
);

-- A consulta que a tela do administrador faz: o rastro de UMA pessoa, do mais
-- recente para trás.
CREATE INDEX IF NOT EXISTS request_log_user_idx
  ON request_log (user_id, at DESC);

-- A consulta que responde "o que está quebrando agora", sem varrer a tabela
-- inteira. Parcial: só as falhas entram no índice, que é uma fração das linhas.
CREATE INDEX IF NOT EXISTS request_log_falhas_idx
  ON request_log (at DESC) WHERE status >= 400;

-- E o índice da poda. Sem ele, o DELETE diário faz varredura completa numa
-- tabela que só cresce — a operação fica mais cara justamente quando a tabela
-- fica grande, que é quando a poda mais importa.
CREATE INDEX IF NOT EXISTS request_log_at_idx ON request_log (at);

COMMENT ON TABLE request_log IS
  'Rastro para troubleshooting: quem fez o quê e o que o servidor respondeu. Sem corpo, sem IP. Podado aos 30 dias.';
