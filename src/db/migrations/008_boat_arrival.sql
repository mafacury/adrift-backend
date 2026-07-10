-- "Viagem" do barco até o receptor: ele fica navegando (silhueta no horizonte)
-- até arrives_at, e só então atraca (fica disponível na Jornada).
-- Default NOW() = linhas antigas chegam na hora (compatível com a versão atual).
ALTER TABLE receiver_queue
  ADD COLUMN IF NOT EXISTS arrives_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS rq_user_arrives_idx
  ON receiver_queue (user_id, arrives_at)
  WHERE status = 'pending';
