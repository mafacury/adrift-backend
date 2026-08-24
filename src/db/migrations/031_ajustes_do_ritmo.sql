-- 031 — os botões do ritmo no painel
--
-- O ritmo do app morava em três lugares: constante em routing.ts (velocidade
-- da travessia, cota diária, fila), variável de ambiente (prazo de resposta) e
-- esta tabela, com quatro chaves que NINGUÉM lia — botões que giravam e não
-- estavam ligados a nada.
--
-- Ajustar a experiência exigia deploy justamente na hora em que não dá para
-- esperar: com testadores rodando e o retorno chegando. Agora o que decide o
-- ritmo está aqui, e o painel gira de verdade.

-- ── os quatro órfãos ────────────────────────────────────────────────────────
-- Nenhum código lê estas chaves. Ficar na tela é pior que não existir: quem
-- gira acha que mudou alguma coisa.
DELETE FROM system_settings
 WHERE key IN ('hop_interval_hours', 'queue_size', 'max_ignores', 'boat_expiry_days');

-- ── os que valem ────────────────────────────────────────────────────────────
INSERT INTO system_settings (key, value, label, kind, help) VALUES
  ('prazo_resposta_horas', '12', 'Prazo para responder (horas)', 'number',
   'Quanto tempo alguém tem para escrever antes de o barco seguir viagem. É o número que mais afeta quem está em fuso distante: um barco que atraca de madrugada já era. Subir para 24 dá uma noite de folga.'),

  ('barcos_por_dia', '8', 'Barcos por pessoa, por dia', 'number',
   'Quantos barcos um dia de app entrega a cada um. O espaçamento entre chegadas sai deste número: 8 por dia é um a cada 3 horas. Baixar deixa cada chegada mais rara e mais esperada.'),

  ('fila_maxima', '2', 'Barcos esperando ao mesmo tempo', 'number',
   'Quantos barcos podem estar atracados na mesma pessoa de uma vez. Mais que isso vira lista de tarefas em vez de encontro.'),

  ('travessia_km_por_min', '30', 'Velocidade do barco (km por minuto)', 'number',
   'Quanto o barco anda por minuto. Número MAIOR = travessia mais rápida. Com a comunidade grande o barco acha porto depressa; baixar aqui é o que devolve a sensação de travessia.'),

  ('travessia_base_min', '20', 'Travessia mínima (minutos)', 'number',
   'Piso de qualquer travessia, mesmo entre países vizinhos. Sem ele, porto perto vira teletransporte.'),

  ('travessia_teto_min', '720', 'Travessia máxima (minutos)', 'number',
   'Teto da travessia mais longa, do outro lado do mundo. 720 = meio dia.')
ON CONFLICT (key) DO NOTHING;
