-- 030 — indicação
--
-- A tela "Sobre o Adrift" já prometia um presente "ao indicar alguém que lança
-- o primeiro barco". A promessa estava escrita e não existia nada por trás: sem
-- código de convite, sem registro de quem trouxe quem, sem prêmio. Era o laço
-- de crescimento mais natural do app, anunciado e ausente.
--
-- `ref_code` nasce NULO e é criado na primeira vez que a pessoa pede o link.
-- Assim não é preciso preencher para quem já existe, e quem nunca convidar
-- ninguém não carrega um código à toa.
--
-- `referral_rewarded_at` fica no INDICADO, não em quem indicou: a regra é "uma
-- recompensa por pessoa trazida", e a marca no indicado é o que torna isso
-- impossível de burlar por mais barcos que ele lance.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ref_code TEXT,
  ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referral_rewarded_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS users_ref_code_uq
  ON users (ref_code) WHERE ref_code IS NOT NULL;

-- Para contar quantos alguém trouxe sem varrer a tabela inteira.
CREATE INDEX IF NOT EXISTS users_referred_by_idx
  ON users (referred_by) WHERE referred_by IS NOT NULL;

COMMENT ON COLUMN users.ref_code IS
  'Código do link de convite. NULO até a pessoa pedir o link pela primeira vez.';
COMMENT ON COLUMN users.referred_by IS
  'Quem trouxe esta pessoa. Gravado no cadastro, a partir do código do link.';
COMMENT ON COLUMN users.referral_rewarded_at IS
  'Quando o indicador foi premiado por ESTA pessoa. Uma vez só, no primeiro barco dela.';
