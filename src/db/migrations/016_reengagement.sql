-- Reconquista: avisar quem sumiu, sem comprometer barco.
--
-- Quem passa dos 7 dias sem aparecer some do sorteio de receptores
-- (services/routing.ts). O problema é que o único aviso capaz de trazer a
-- pessoa de volta — o push de "um barco está a caminho" — é justamente o que
-- deixa de acontecer. Um alçapão sem maçaneta do lado de dentro.
--
-- A saída é um aviso que NÃO reserva barco nenhum: se a pessoa não voltar, não
-- custou uma travessia parada. Esta coluna guarda quando ela foi chamada pela
-- última vez, para o convite não virar perseguição.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_nudge_at TIMESTAMPTZ;

-- A varredura procura gente dormindo com push registrado; o índice evita
-- varrer a tabela inteira a cada rodada.
CREATE INDEX IF NOT EXISTS users_dormant_idx
  ON users (last_active_at)
  WHERE fcm_token IS NOT NULL AND ban_status = 'active';
