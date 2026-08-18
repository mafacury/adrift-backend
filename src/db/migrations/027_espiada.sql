-- 027 — registro de espiada administrativa
--
-- Toda vez que um administrador entra na visão de outro usuário, fica escrito
-- aqui: quem espiou, quem foi espiado, quando e de qual IP.
--
-- Não é burocracia. É o que separa "ferramenta de suporte" de "porta dos
-- fundos". Sem registro, ninguém — nem o próprio dono do app — consegue
-- responder depois "quem abriu a conta de fulano em março?". E é exatamente por
-- não conseguir responder isso que uma senha mestra é má ideia: ela abre tudo e
-- não deixa rastro de quem a usou.
--
-- Guardar o alvo com ON DELETE SET NULL de propósito: se a pessoa pedir a
-- exclusão da conta, o registro da espiada continua existindo (o fato
-- aconteceu), mas deixa de apontar para alguém.

CREATE TABLE IF NOT EXISTS impersonation_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id   UUID     REFERENCES users(id) ON DELETE SET NULL,
  target_email TEXT,          -- congelado no momento da espiada
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS impersonation_admin_idx  ON impersonation_log (admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS impersonation_target_idx ON impersonation_log (target_id, created_at DESC);
