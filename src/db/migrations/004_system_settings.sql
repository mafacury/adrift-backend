CREATE TABLE IF NOT EXISTS system_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  label      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system_settings (key, value, label) VALUES
  ('hop_interval_hours', '24',  'Intervalo entre saltos (horas)'),
  ('queue_size',         '3',   'Usuários que recebem o barco ao mesmo tempo'),
  ('max_ignores',        '10',  'Máx. ignorados antes de pausar barco'),
  ('boat_expiry_days',   '30',  'Dias sem movimentação para arquivar barco')
ON CONFLICT (key) DO NOTHING;
