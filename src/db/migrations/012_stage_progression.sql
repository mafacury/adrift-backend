-- Nova progressão de 8 modelos (mensagens + portões de países) — recalcula
-- o estágio de todos os barcos existentes de uma vez.
-- Manter em sincronia com services/progress.ts (STAGE_CASE_SQL).
UPDATE boats b SET stage = CASE
  WHEN (SELECT COUNT(*) FROM boat_messages  WHERE boat_id = b.id) >= 800
   AND (SELECT COUNT(*) FROM boat_countries WHERE boat_id = b.id) >= 160 THEN 8
  WHEN (SELECT COUNT(*) FROM boat_messages  WHERE boat_id = b.id) >= 450
   AND (SELECT COUNT(*) FROM boat_countries WHERE boat_id = b.id) >= 120 THEN 7
  WHEN (SELECT COUNT(*) FROM boat_messages  WHERE boat_id = b.id) >= 250
   AND (SELECT COUNT(*) FROM boat_countries WHERE boat_id = b.id) >= 80  THEN 6
  WHEN (SELECT COUNT(*) FROM boat_messages  WHERE boat_id = b.id) >= 120
   AND (SELECT COUNT(*) FROM boat_countries WHERE boat_id = b.id) >= 40  THEN 5
  WHEN (SELECT COUNT(*) FROM boat_messages  WHERE boat_id = b.id) >= 60 THEN 4
  WHEN (SELECT COUNT(*) FROM boat_messages  WHERE boat_id = b.id) >= 25 THEN 3
  WHEN (SELECT COUNT(*) FROM boat_messages  WHERE boat_id = b.id) >= 10 THEN 2
  ELSE 1
END;
