-- 037 — a marca de "eu vi o meu barco chegar"
--
-- O fim da jornada já avisa por push e e-mail (`avisoVoltouParaCasa`, em
-- services/journey.ts). O que faltava era DENTRO do app: o barco atracava,
-- virava quadro no museu, e quem abrisse o app depois não via nada. O desfecho
-- de semanas de viagem passava em silêncio para quem estivesse com a
-- notificação desligada — que é a maioria.
--
-- Esta coluna é o corte da comemoração de chegada, no mesmo molde das outras
-- duas que já existem:
--
--   presente   users.gifts_seen_at   (relógio)
--   evolução   boats.stage_seen      (nível por barco)
--   chegada    boats.chegada_vista_at  ← esta
--
-- Fica no BARCO e não no usuário porque a pergunta é por barco: quem tem dois
-- voltando na mesma semana merece as duas cerimônias, na ordem em que
-- chegaram. Um relógio no usuário engoliria a segunda.
--
-- ── O preenchimento retroativo não é detalhe: é o ponto ────────────────────
--
-- Em 07/09/2026 havia 9 barcos arquivados, de 6 pessoas, o mais antigo de
-- 03/08. Sem a linha abaixo, todas as 6 abririam o app e receberiam a festa de
-- chegada de barcos que atracaram há mais de um mês — uma comemoração que
-- chega atrasada não é comemoração, é confusão.
--
-- Barco que atracar A PARTIR DE AGORA nasce com a coluna nula, e é isso que
-- faz a cerimônia aparecer uma vez, na hora certa.

ALTER TABLE boats ADD COLUMN IF NOT EXISTS chegada_vista_at TIMESTAMPTZ;

-- Tudo que já estava arquivado conta como visto.
UPDATE boats
   SET chegada_vista_at = COALESCE(archived_at, NOW())
 WHERE status = 'archived'
   AND chegada_vista_at IS NULL;

-- A consulta da fila pergunta "meus barcos arquivados ainda não vistos".
-- Parcial porque a resposta interessante é sempre um punhado de linhas, e a
-- tabela inteira não deveria ser varrida por causa disso.
CREATE INDEX IF NOT EXISTS boats_chegada_por_ver_idx
  ON boats (creator_user_id, archived_at)
  WHERE status = 'archived' AND chegada_vista_at IS NULL;

COMMENT ON COLUMN boats.chegada_vista_at IS
  'Quando o dono viu a cerimônia de chegada deste barco. Nulo = ainda por ver.';
