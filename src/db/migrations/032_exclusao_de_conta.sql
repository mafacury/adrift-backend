-- 032 — exclusão de conta
--
-- O Termo promete duas coisas ao mesmo tempo, e elas puxam para lados opostos:
-- apagar a conta de quem pede, E manter nos barcos as mensagens já entregues a
-- estranhos ("elas fazem parte da história daqueles barcos").
--
-- Apagar a linha de `users` faria o contrário do prometido: `boat_messages`
-- tem `user_id NOT NULL REFERENCES users(id) ON DELETE CASCADE`, então o
-- DELETE levaria junto TODA mensagem que a pessoa escreveu — inclusive as que
-- estão hoje em barcos de outras pessoas, no meio de conversas que não são só
-- dela. Estranhos perderiam algo que receberam.
--
-- Por isso a exclusão é por ANONIMIZAÇÃO: o cadastro deixa de existir como
-- pessoa (e-mail, senha, país, idioma, aparelho — tudo some ou vira lápide), a
-- linha continua só como âncora da chave estrangeira, e as mensagens ficam nos
-- barcos sem ligação utilizável com ninguém.
--
-- `deleted_at` é o que separa "conta viva" de "lápide": o login recusa, o
-- roteamento não manda mais barco, e o gancho global barra qualquer requisição
-- feita com um token antigo — que continua válido, porque token do Adrift não
-- expira.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS users_deleted_idx ON users (deleted_at)
  WHERE deleted_at IS NOT NULL;

COMMENT ON COLUMN users.deleted_at IS
  'Quando a pessoa pediu a exclusão. Preenchido = lápide: sem login, sem barco novo, sem acesso.';

-- O motivo do arquivamento tem uma restrição fechada (migração 015). Sem
-- acrescentar 'conta_excluida' ali, arquivar os barcos de quem se apaga
-- violaria a restrição e a exclusão inteira falharia na transação.
ALTER TABLE boats DROP CONSTRAINT IF EXISTS boats_archive_reason_check;
ALTER TABLE boats ADD  CONSTRAINT boats_archive_reason_check
  CHECK (archive_reason IS NULL OR archive_reason IN
    ('chamado', 'lendaria', 'esgotado', 'perdido', 'moderado', 'conta_excluida'));
