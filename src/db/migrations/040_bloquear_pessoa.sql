-- Bloquear uma pessoa — 23/09/2026
--
-- O Adrift é anônimo entre estranhos: ninguém sabe quem escreveu o que. Por
-- isso o bloqueio NUNCA é pedido por id de usuário — a tela manda o id da
-- MENSAGEM e o servidor resolve o autor. É o que permite bloquear alguém sem
-- nunca saber quem ela é.
--
-- Vale para os dois lados: o par (A bloqueou B) esconde o que B escreve de A E
-- o que A escreve de B, e impede o roteamento de levar barco de um para o
-- outro. Por isso toda consulta que usa esta tabela olha as DUAS colunas.

CREATE TABLE IF NOT EXISTS user_blocks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- de onde veio a mensagem que motivou o bloqueio. É o único dado que a
  -- pessoa vê na lista de bloqueios, e ela já o tinha visto na mensagem —
  -- guardar o país não revela nada novo. O id do autor nunca sai daqui.
  country_code     CHAR(2),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- bloquear duas vezes é a mesma coisa que bloquear uma
  UNIQUE (blocker_user_id, blocked_user_id),
  -- bloquear a si mesmo não significa nada e quebraria o roteamento
  CHECK (blocker_user_id <> blocked_user_id)
);

-- Os dois sentidos são consultados com a mesma frequência: o filtro de
-- mensagem pergunta "há bloqueio entre mim e o autor?", sem saber quem
-- bloqueou quem. Um índice por coluna cobre as duas metades do OR.
CREATE INDEX IF NOT EXISTS user_blocks_blocker_idx ON user_blocks (blocker_user_id);
CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx ON user_blocks (blocked_user_id);
