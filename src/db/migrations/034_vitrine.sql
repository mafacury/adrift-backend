-- 034 — a vitrine
--
-- "Look around first": um botão na tela de entrada que deixa a pessoa olhar o
-- app inteiro sem criar conta. Veio de um comentário no Reddit — alguém tentou
-- e desistiu no formulário de cadastro, que é caro demais para "vou dar uma
-- olhada de cinco minutos".
--
-- Não é usuário e senha "demo/demo". Quem bate num formulário de login e
-- desiste não é salvo por outro formulário de login: é um toque, sem digitar
-- nada. E credencial pública com senha seria pior: cada tentativa roda um
-- bcrypt de custo 12, então publicar a senha num fórum é convidar alguém a
-- fazer um laço e derrubar o servidor.
--
-- ── A coluna ───────────────────────────────────────────────────────────────
--
-- Os barcos da vitrine precisam parecer vivos: navegando no mapa, com prazo
-- correndo, com histórico. Mas eles NÃO PODEM cair na fila de uma pessoa de
-- verdade — seria um barco falso ocupando as 12 horas de alguém, e o pior tipo
-- de bug, porque para quem recebeu não há como saber.
--
-- `vitrine` marca esses barcos. A trava mora em `processRouting`, que é o
-- funil único: nenhum barco entra na fila de ninguém sem passar por lá. Uma
-- linha lá dentro protege todos os caminhos, inclusive os que forem escritos
-- amanhã por quem nunca ouviu falar desta coluna.

ALTER TABLE boats
  ADD COLUMN IF NOT EXISTS vitrine BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN boats.vitrine IS
  'Barco de demonstração, para quem entra sem conta. Nunca é roteado a uma pessoa real.';

-- São três barcos no mundo inteiro: o índice parcial é minúsculo e evita a
-- varredura completa no trabalho que mantém a vitrine viva.
CREATE INDEX IF NOT EXISTS boats_vitrine_idx ON boats (id) WHERE vitrine;
