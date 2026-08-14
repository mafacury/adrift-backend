-- Aceite dos Termos de Uso, registrado no cadastro.
--
-- Guardamos QUANDO e QUAL versão. A versão importa: se um dia o texto mudar,
-- é preciso saber com o que cada pessoa concordou — "aceitou os termos" sem
-- dizer quais não prova nada. O texto de cada versão vive no código do app
-- (mobile/constants/terms.ts), que é versionado junto.
--
-- Nulo em quem já existia antes desta migração (e nos bots). Não preenchemos
-- retroativamente de propósito: registrar um aceite que nunca aconteceu seria
-- inventar o fato que a coluna existe para provar.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS terms_version     TEXT;

COMMENT ON COLUMN users.terms_accepted_at IS
  'Quando a pessoa marcou o aceite no cadastro. Nulo = conta anterior aos termos.';
COMMENT ON COLUMN users.terms_version IS
  'Versão do texto aceito, ex. "2026-08-06". Ver mobile/constants/terms.ts.';
