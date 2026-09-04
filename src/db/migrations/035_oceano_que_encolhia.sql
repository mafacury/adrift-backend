-- 035 — os dois prazos de esquecimento
--
-- Três regras tiram um barco da lista de alguém: já recebeu, deixou expirar, e
-- deixou passar vezes demais. A primeira sempre teve prazo (21 dias). As outras
-- duas nasceram permanentes — só somavam, nunca esqueciam.
--
-- O resultado é um oceano que encolhe monotonicamente até zero, sem quebrar
-- nada: nenhum erro, nenhum log, os barcos simplesmente passam todos pelos
-- bots. Em 04/09/2026 o dono estava havia dois dias sem receber nada e, dos 47
-- barcos ativos, ZERO conseguiam achar um humano — 19 barrados por terem
-- expirado e 8 por "deixar passar", todos para sempre.
--
-- Estes dois botões são o prazo que faltava. Lidos por `ajustesDoFluxo()`; se
-- as linhas sumirem ou vierem tortas, o código cai nos mesmos padrões (14 e 30).

INSERT INTO system_settings (key, value, label, kind, help) VALUES
  ('carencia_expirado_dias', '14', 'Carência do barco perdido (dias)', 'number',
   'Quando um barco atraca e a pessoa não responde a tempo, ele fica de fora da lista dela por este prazo — e depois pode voltar. Antes disto era para sempre, e barco que chega de madrugada se perdia definitivamente. Subir torna cada perda mais cara; baixar devolve o barco mais cedo.'),

  ('janela_deixar_passar_dias', '30', 'Memória do "deixar passar" (dias)', 'number',
   'Por quanto tempo um toque em "deixar passar" continua contando contra aquele barco. Dois toques dentro da janela e ele para de vir. Passado o prazo, os toques antigos são esquecidos — quinze mensagens depois o barco já é outro assunto.')
ON CONFLICT (key) DO NOTHING;
