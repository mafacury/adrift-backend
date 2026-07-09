-- Marca até quando o criador já "viu" o aviso de presentes recebidos nos barcos dele.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS gifts_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
