-- 025 — defesas antispam
--
-- Três coisas, todas aditivas: nada aqui altera ou apaga o que já existe.
--
-- 1. moderation_log.user_id — o log registrava boat_id e message_id, mas não
--    QUEM escreveu. Para banir por histórico é preciso contar rejeições por
--    autor, e message_id não serve: é ON DELETE SET NULL, então some justamente
--    nos casos apagados. Guardar o autor direto é o que torna a conta confiável.
--
-- 2. users.email_verified — verificação de e-mail. Fica `true` para todo mundo
--    que já existe: ninguém é trancado para fora por uma regra criada depois.
--
-- 3. email_verifications — os tokens, no mesmo molde de password_resets:
--    guardamos o HASH do token, nunca ele mesmo. Vazamento de banco não vira
--    conta verificada de graça.

ALTER TABLE moderation_log
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS moderation_log_user_recent_idx
  ON moderation_log (user_id, created_at DESC)
  WHERE verdict = 'rejected';

-- Backfill do que dá para recuperar pela mensagem ainda existente.
UPDATE moderation_log ml
   SET user_id = bm.user_id
  FROM boat_messages bm
 WHERE ml.message_id = bm.id
   AND ml.user_id IS NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;

-- Daqui para a frente o padrão é "não verificado"; quem já estava fica como está.
ALTER TABLE users
  ALTER COLUMN email_verified SET DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS email_verifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_verifications_hash_idx
  ON email_verifications (token_hash);
CREATE INDEX IF NOT EXISTS email_verifications_user_idx
  ON email_verifications (user_id, created_at DESC);
