-- 036 — a trava que a fila nunca teve
--
-- `enqueueForReceiver()` sempre terminou com `ON CONFLICT DO NOTHING`, com cara
-- de proteção contra enfileirar o mesmo barco duas vezes para a mesma pessoa.
-- Nunca protegeu nada: os índices de `receiver_queue` eram a chave primária em
-- `id` (uuid novo a cada linha, que nunca conflita) e cinco índices comuns.
-- Sem restrição ÚNICA em (boat_id, user_id) não há com o que conflitar, e a
-- cláusula nunca disparou uma única vez.
--
-- O estrago é silencioso e pequeno até não ser. Cada duplicata:
--   · ocupa duas vagas do teto de fila (`fila_maxima`, hoje 2), então a pessoa
--     fica com a fila cheia por causa de um barco só;
--   · faz um toque em "deixar passar" marcar as DUAS linhas como `skipped` —
--     o que, depois do conserto de 04/09/2026, conta como dois toques e derruba
--     o barco da lista dela na hora, em vez de nos dois toques que a regra
--     promete.
--
-- ── Por que o índice é PARCIAL ─────────────────────────────────────────────
--
-- `WHERE status = 'pending'` é o ponto todo. Uma restrição única sobre
-- (boat_id, user_id) sem filtro barraria a revisita legítima: o mesmo barco
-- voltando para a mesma pessoa meses depois, que é exatamente o que a carência
-- da migração 035 passou a permitir. O que não pode existir duas vezes é a
-- linha VIVA — as mortas (`delivered`, `expired`, `skipped`) podem se repetir à
-- vontade, e é assim que a memória do "deixar passar" funciona.
--
-- ── Cuidado ao mexer no INSERT ─────────────────────────────────────────────
--
-- Com índice parcial, `ON CONFLICT DO NOTHING` sem alvo NÃO o enxerga. O insert
-- em `services/routing.ts` precisa nomear o alvo e repetir o predicado:
--   ON CONFLICT (boat_id, user_id) WHERE status = 'pending' DO NOTHING
-- Foi feito junto desta migração.

-- ── 1. Ponto de restauração dos dados ──────────────────────────────────────
--
-- Apagar linha é o único passo daqui que o git não desfaz. As condenadas vão
-- inteiras para esta tabela antes de sumir da fila. `LIKE` copia as colunas e
-- só elas: sem chave estrangeira, a cópia sobrevive mesmo que o barco seja
-- apagado depois. Se algum dia estiver claro que ninguém precisa mais delas,
-- é um DROP TABLE e pronto.

CREATE TABLE IF NOT EXISTS receiver_queue_duplicatas (LIKE receiver_queue);

ALTER TABLE receiver_queue_duplicatas
  ADD COLUMN IF NOT EXISTS arquivado_em TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ── 2. Guardar e limpar ────────────────────────────────────────────────────
--
-- De cada grupo (boat_id, user_id) com mais de uma linha `pending`, sobrevive a
-- MAIS ANTIGA: ela é a original, e é a que a pessoa já vinha vendo, com o
-- `arrives_at` e o `expires_at` que ela já conhece. As outras são o acidente.
-- O desempate por `id` existe só para o resultado não depender de sorte quando
-- duas linhas nascem no mesmo instante.

WITH ranqueadas AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY boat_id, user_id
           ORDER BY queued_at ASC, id ASC
         ) AS posicao
  FROM receiver_queue
  WHERE status = 'pending'
)
INSERT INTO receiver_queue_duplicatas
SELECT rq.*, NOW()
FROM receiver_queue rq
WHERE rq.id IN (SELECT id FROM ranqueadas WHERE posicao > 1);

DELETE FROM receiver_queue
WHERE id IN (SELECT id FROM receiver_queue_duplicatas);

-- ── 3. A trava ─────────────────────────────────────────────────────────────
--
-- Se este CREATE falhar com "could not create unique index", é porque o passo 2
-- deixou duplicata para trás — e aí a migração inteira volta atrás sozinha, que
-- é o que se quer. O runner roda cada arquivo dentro de uma transação só
-- (ver src/db/migrate.ts).

CREATE UNIQUE INDEX IF NOT EXISTS rq_sem_duplicado_idx
  ON receiver_queue (boat_id, user_id)
  WHERE status = 'pending';
