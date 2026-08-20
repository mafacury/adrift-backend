-- 029 — idioma de cada mensagem
--
-- Traduzir custa por token, e traduzir do português para o português custa
-- igual e não entrega nada. Hoje a coluna inteira vai para a IA quando alguém
-- pede tradução, mesmo as mensagens que já estão no idioma de quem lê: o
-- próprio prompt manda "se já estiver em português, devolva o texto exatamente
-- igual". Ou seja, pagamos para não fazer nada — e num app onde a maior parte
-- do primeiro público escreve na mesma língua, isso é a maior parte da conta.
--
-- Com o idioma gravado na hora em que a mensagem NASCE, essas saem da conta
-- antes de qualquer chamada. Não é palpite: é o idioma que a pessoa estava
-- usando no app no momento em que escreveu.
--
-- NULO nas que já existem, e nulo quer dizer "não sei" — o que não se sabe vai
-- para a IA, que é exatamente o que já acontecia. Nada regride.

ALTER TABLE boat_messages
  ADD COLUMN IF NOT EXISTS lang TEXT;

COMMENT ON COLUMN boat_messages.lang IS
  'Idioma em que a mensagem foi escrita (ISO 639-1). NULO = desconhecido, vai para a IA.';
