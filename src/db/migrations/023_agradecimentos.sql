-- Agradecimentos por presente — o único caminho de volta que existe no Adrift.
--
-- Guarda a CHAVE da frase, não o texto. Três razões:
--   1. o app renderiza a frase, então traduzi-la é uma tabela no cliente e não
--      uma migração de dados;
--   2. chave fechada é validável — não há como enfiar texto livre por aqui,
--      que é a regra do produto (nunca comunicação de mão dupla livre);
--   3. se um dia uma frase for reescrita, todos os recados antigos melhoram
--      juntos, porque nenhum deles carrega a redação antiga.
--
-- UNIQUE(message_id, from_user_id): um agradecimento por presente. Sem isso o
-- mesmo botão viraria um canal de repetição, que é o que a regra evita.

CREATE TABLE IF NOT EXISTS gift_thanks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- a mensagem que trazia o presente
  message_id   UUID NOT NULL REFERENCES boat_messages(id) ON DELETE CASCADE,
  -- quem agradece (dono do barco) e quem recebe o obrigado (quem deu)
  from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phrase_key   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seen_at      TIMESTAMPTZ,
  UNIQUE (message_id, from_user_id)
);

CREATE INDEX IF NOT EXISTS gift_thanks_to_idx
  ON gift_thanks (to_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS gift_thanks_unseen_idx
  ON gift_thanks (to_user_id) WHERE seen_at IS NULL;

COMMENT ON COLUMN gift_thanks.phrase_key IS
  'Chave de frase pronta. O texto vive no app (constants/agradecimentos.ts).';
