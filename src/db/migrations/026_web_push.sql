-- 026 — assinaturas de Web Push
--
-- Por que uma tabela nova em vez de reaproveitar users.fcm_token: são coisas
-- diferentes. O fcm_token é UM token do Expo por conta, do aplicativo. Web Push
-- é uma assinatura POR NAVEGADOR — a mesma pessoa tem uma no computador do
-- trabalho, outra no de casa, outra no celular, e todas devem tocar. Enfiar isso
-- numa coluna só significaria escolher qual delas avisar, que é a decisão que
-- fez o barco se perder.
--
-- `endpoint` é a URL que o navegador dá e que identifica a assinatura; é única
-- por natureza, então serve de chave. As duas chaves (p256dh e auth) são o que
-- cifra a mensagem para aquele navegador — sem elas o push não é entregue.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_ok_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS push_subs_user_idx ON push_subscriptions (user_id);

-- Marcas de aviso já dado, na própria linha da fila.
--
-- Sem isto a varredura de minuto em minuto reenviaria o mesmo aviso a cada
-- passagem — o barco chegou uma vez, mas o alerta sairia 720 vezes ao longo das
-- 12 horas. Guardar QUANDO cada aviso saiu é o que torna cada um único, e ainda
-- deixa o histórico legível para depurar ("chegou 9h02, avisei 9h02, avisei o
-- prazo 19h02, expirou 21h02").
ALTER TABLE receiver_queue
  ADD COLUMN IF NOT EXISTS avisado_chegada_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS avisado_prazo_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS avisado_perda_at   TIMESTAMPTZ;

-- As varreduras procuram exatamente por "pendente e ainda não avisado".
CREATE INDEX IF NOT EXISTS rq_aviso_chegada_idx
  ON receiver_queue (arrives_at)
  WHERE status = 'pending' AND avisado_chegada_at IS NULL;

CREATE INDEX IF NOT EXISTS rq_aviso_prazo_idx
  ON receiver_queue (expires_at)
  WHERE status = 'pending' AND avisado_prazo_at IS NULL;
