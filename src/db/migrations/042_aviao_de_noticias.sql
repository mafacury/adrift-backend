-- 042 — o avião de notícias da Jornada (05/10/2026)
--
-- De tempos em tempos um aviãozinho de publicidade cruza o céu da Jornada
-- puxando uma faixa com uma notícia do oceano (ver services/noticias.ts). O
-- intervalo entre dois voos é sorteado entre estes dois números, e eles ficam
-- no painel para o ritmo ser acertado sem deploy — se cansar, sobe; se a tela
-- parecer parada, desce.

INSERT INTO system_settings (key, value, label, kind, help) VALUES
  ('aviao_intervalo_min_s', '45', 'Avião de notícias: intervalo mínimo (segundos)', 'number',
   'O menor tempo entre dois voos do aviãozinho que cruza o céu da Jornada com uma notícia do oceano. O intervalo de verdade é sorteado entre este número e o máximo abaixo.'),

  ('aviao_intervalo_max_s', '120', 'Avião de notícias: intervalo máximo (segundos)', 'number',
   'O maior tempo entre dois voos do aviãozinho. Se ficar menor que o mínimo, vale o mínimo.')
ON CONFLICT (key) DO NOTHING;
