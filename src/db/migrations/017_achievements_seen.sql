-- O INSTANTE da conquista.
--
-- As conquistas são calculadas a partir das métricas do usuário (ver
-- services/achievements.ts) — o que é ótimo, porque vale retroativo e não
-- precisa de migração a cada catálogo novo. Mas tem um custo: não existe o
-- momento em que ela ACONTECE. A pessoa lança o quinto barco, cumpre a
-- "Frota", e a tela não diz nada; ela só descobre se abrir a lista depois.
--
-- Esta tabela guarda o que já foi comemorado. O que está cumprido e não está
-- aqui é uma comemoração pendente.
CREATE TABLE IF NOT EXISTS achievements_seen (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id TEXT NOT NULL,
  seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, achievement_id)
);

CREATE INDEX IF NOT EXISTS achievements_seen_user_idx ON achievements_seen (user_id);
