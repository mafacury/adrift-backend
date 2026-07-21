-- Fim da jornada: o barco volta para casa, atraca e vira quadro no Museu do Porto.
-- Ver adrift-fim-da-jornada-plano.md (Etapa 1).

-- 'returning' = travessia de volta em andamento (não recebe mais mensagens).
ALTER TABLE boats DROP CONSTRAINT IF EXISTS boats_status_check;
ALTER TABLE boats ADD  CONSTRAINT boats_status_check
  CHECK (status IN ('active', 'paused', 'returning', 'archived'));

ALTER TABLE boats ADD COLUMN IF NOT EXISTS returning_at    TIMESTAMPTZ;
ALTER TABLE boats ADD COLUMN IF NOT EXISTS arrives_home_at TIMESTAMPTZ;
ALTER TABLE boats ADD COLUMN IF NOT EXISTS archived_at     TIMESTAMPTZ;
ALTER TABLE boats ADD COLUMN IF NOT EXISTS final_note      TEXT;
ALTER TABLE boats ADD COLUMN IF NOT EXISTS home_country    CHAR(2);
-- milhas náuticas congeladas no arquivamento (o quadro não recalcula)
ALTER TABLE boats ADD COLUMN IF NOT EXISTS total_nm        REAL;
-- "deixaram passar" SEGUIDOS: soma a cada ignore, zera a cada mensagem nova.
-- Acumulado seria injusto — um barco ótimo junta 10 ao longo de meses.
ALTER TABLE boats ADD COLUMN IF NOT EXISTS idle_ignores    INT NOT NULL DEFAULT 0;

ALTER TABLE boats DROP CONSTRAINT IF EXISTS boats_archive_reason_check;
ALTER TABLE boats ADD COLUMN IF NOT EXISTS archive_reason  TEXT;
ALTER TABLE boats ADD  CONSTRAINT boats_archive_reason_check
  CHECK (archive_reason IS NULL OR archive_reason IN
    ('chamado', 'lendaria', 'esgotado', 'perdido', 'moderado'));

CREATE INDEX IF NOT EXISTS boats_returning_idx
  ON boats (arrives_home_at) WHERE status = 'returning';
CREATE INDEX IF NOT EXISTS boats_archived_idx
  ON boats (creator_user_id, archived_at DESC) WHERE status = 'archived';

-- Barcos que o job antigo já arquivou (sem cerimônia) ganham data e motivo,
-- senão apareceriam no museu sem selo nenhum.
UPDATE boats
   SET archived_at    = COALESCE(archived_at, last_hop_at),
       archive_reason = COALESCE(archive_reason, 'perdido')
 WHERE status = 'archived';
