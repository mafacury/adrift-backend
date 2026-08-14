-- Recuperação de senha.
--
-- O token NÃO fica guardado aqui: o que fica é o SHA-256 dele. Quem tiver o
-- banco em mãos — um vazamento, um dump esquecido, um backup mal guardado —
-- não consegue entrar em conta nenhuma, porque o que está gravado não serve
-- para abrir nada. O token de verdade só existe no e-mail da pessoa.
--
-- Uso único e com prazo: `used_at` marca o gasto, `expires_at` mata o resto.
-- Um link de recuperação que vale para sempre é uma senha permanente escondida
-- na caixa de e-mail.

CREATE TABLE IF NOT EXISTS password_resets (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  -- de onde partiu o pedido, para investigar abuso sem depender de log
  requested_ip TEXT
);

CREATE INDEX IF NOT EXISTS password_resets_user_idx
  ON password_resets (user_id, created_at DESC);

COMMENT ON COLUMN password_resets.token_hash IS
  'SHA-256 do token. O token em claro nunca toca o banco.';
