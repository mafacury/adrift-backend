-- Marca até quando o usuário já "viu" o aviso de barcos perdidos.
-- Barcos perdidos = entradas na fila dele que expiraram (status 'expired')
-- depois deste instante ainda não foram reconhecidas.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS missed_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Consulta rápida das entradas expiradas por usuário
CREATE INDEX IF NOT EXISTS rq_user_expired_idx
  ON receiver_queue (user_id, expires_at)
  WHERE status = 'expired';
