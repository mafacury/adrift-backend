-- 028 — idioma de cada pessoa
--
-- O app decide o idioma da TELA sozinho, pelo aparelho. Mas o servidor manda
-- e-mail e push quando o app está fechado, e nessa hora não tem como perguntar
-- ao navegador de ninguém. Sem esta coluna, o aviso de "faltam 2 horas" sai em
-- português para quem nunca leu português.
--
-- Fica NULO para quem já existe: nulo quer dizer "não sei", e o código cai em
-- português — que é o que essas pessoas já vinham recebendo. Preencher com um
-- palpite seria pior do que admitir que não se sabe.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS lang TEXT;

COMMENT ON COLUMN users.lang IS
  'Idioma preferido (ISO 639-1: pt, en, es...). NULO = desconhecido, cai em pt.';
