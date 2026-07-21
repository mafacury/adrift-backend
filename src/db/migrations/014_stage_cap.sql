-- A tabela boats nasceu (migração 001) com CHECK (stage BETWEEN 1 AND 6),
-- mas a progressão nova vai até 8 (services/progress.ts + migração 012).
-- Ninguém percebeu porque nenhum barco chegou perto de 450 mensagens ainda —
-- o PRIMEIRO barco a alcançar o estágio 7 faria o UPDATE de progressão falhar.
-- A Nau Lendária (estágio 8) é gatilho do fim da jornada, então isso precisa
-- ser corrigido antes.
ALTER TABLE boats DROP CONSTRAINT IF EXISTS boats_stage_check;
ALTER TABLE boats ADD  CONSTRAINT boats_stage_check CHECK (stage BETWEEN 1 AND 8);
