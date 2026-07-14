/**
 * Progressão do barco — 8 modelos.
 * Sobe por MENSAGENS recebidas (métrica infinita, ritmo ~8-10/dia por barco)
 * com "portões" de PAÍSES únicos nos níveis altos (prestígio finito, máx 195).
 *
 *   1 Bote          — lançamento
 *   2 Veleiro       — 10 mensagens
 *   3 Bergantim     — 25 mensagens
 *   4 Caravela      — 60 mensagens
 *   5 Galé          — 120 mensagens + 40 países
 *   6 Galeão        — 250 mensagens + 80 países
 *   7 Navio         — 450 mensagens + 120 países
 *   8 Nau Lendária  — 800 mensagens + 160 países  (👑 momento raro, ~3-4 meses)
 *
 * Fragmento SQL para UPDATEs em boats — usa $1 = id do barco.
 * Manter em sincronia com a migração 012 e com STAGE_* no app (map.tsx etc).
 */
export const STAGE_CASE_SQL = `CASE
  WHEN (SELECT COUNT(*) FROM boat_messages  WHERE boat_id = $1) >= 800
   AND (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 160 THEN 8
  WHEN (SELECT COUNT(*) FROM boat_messages  WHERE boat_id = $1) >= 450
   AND (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 120 THEN 7
  WHEN (SELECT COUNT(*) FROM boat_messages  WHERE boat_id = $1) >= 250
   AND (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 80  THEN 6
  WHEN (SELECT COUNT(*) FROM boat_messages  WHERE boat_id = $1) >= 120
   AND (SELECT COUNT(*) FROM boat_countries WHERE boat_id = $1) >= 40  THEN 5
  WHEN (SELECT COUNT(*) FROM boat_messages  WHERE boat_id = $1) >= 60 THEN 4
  WHEN (SELECT COUNT(*) FROM boat_messages  WHERE boat_id = $1) >= 25 THEN 3
  WHEN (SELECT COUNT(*) FROM boat_messages  WHERE boat_id = $1) >= 10 THEN 2
  ELSE 1
END`;
