-- Até que nível de cada barco o dono já viu a comemoração.
--
-- Os presentes novos já tinham rastro (users.gifts_seen_at, um relógio só para
-- tudo). A evolução do barco não tinha nada: o nível é CALCULADO das métricas,
-- então "subiu de nível" é verdade para sempre e não havia como saber se a
-- pessoa já tinha visto aquilo.
--
-- Fica por BARCO, e não por usuário, porque cada casco sobe na sua hora e a
-- comemoração é sobre um barco específico.
--
-- O preenchimento inicial é o nível ATUAL, de propósito: sem isso, quem já tem
-- barco veterano abriria o app e levaria cinco fogos de artifício na cara por
-- evoluções que aconteceram semanas atrás.

ALTER TABLE boats
  ADD COLUMN IF NOT EXISTS stage_seen INT;

UPDATE boats SET stage_seen = stage WHERE stage_seen IS NULL;

ALTER TABLE boats
  ALTER COLUMN stage_seen SET DEFAULT 1;

COMMENT ON COLUMN boats.stage_seen IS
  'Maior nível cuja comemoração o dono já viu. stage > stage_seen = tem festa pendente.';
