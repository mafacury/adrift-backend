-- 041 — Gamificação (28/09/2026)
--
-- 1. Diário de bordo por e-mail. Quem sumiu não sabe que estranhos escreveram
--    no barco dele — medido em 27/09: um americano com 72 mensagens que nunca
--    voltou para ler. O diário conta isso, no máximo uma vez por semana.
--      diario_enviado_at  quando saiu o último (a trava da semana)
--      diario_off         a pessoa pediu para parar (link no próprio e-mail
--                         ou chave no Perfil)
ALTER TABLE users ADD COLUMN IF NOT EXISTS diario_enviado_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS diario_off BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Motivo de arquivamento 'teste': barco de teste do dono. Arquivado como
--    qualquer outro motivo ele entraria nas Lendas (o hall da fama dos
--    arquivados) — e três deles lideravam o ranking mundial com "teste 2".
ALTER TABLE boats DROP CONSTRAINT IF EXISTS boats_archive_reason_check;
ALTER TABLE boats ADD  CONSTRAINT boats_archive_reason_check
  CHECK (archive_reason IS NULL OR archive_reason IN
    ('chamado', 'lendaria', 'esgotado', 'perdido', 'moderado', 'conta_excluida', 'teste'));

-- 3. A Maré da semana soma mensagens por data; sem índice, cada consulta do
--    ranking semanal varreria a tabela inteira de mensagens.
CREATE INDEX IF NOT EXISTS boat_messages_created_idx ON boat_messages (created_at);
