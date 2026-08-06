-- Configurações de TEXTO, para o dono mudar sem passar por um deploy.
--
-- Até aqui system_settings só guardava números (intervalo de saltos, tamanho
-- da fila), e a tela de administração validava tudo com isNaN. A coluna `kind`
-- separa as duas famílias, para a tela saber quando mostrar um campo de texto
-- longo em vez de um campo numérico.
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'number';

ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS help TEXT;

-- A placa pendurada no Pier. Aceita marcação simples — ver services/markup.ts
-- para as etiquetas permitidas. É deliberadamente um subconjunto: HTML solto
-- não existe no aplicativo instalado (lá não há navegador para interpretá-lo) e
-- abriria caminho para injeção na web.
INSERT INTO system_settings (key, value, label, kind, help) VALUES
  ('pier_sign_html',
   'Escreva sua mensagem<br><small>Que sua jornada leve coisas boas por onde passar</small>',
   'Texto da placa do Pier',
   'text',
   'Aceita <b>negrito</b>, <i>itálico</i>, <small>menor</small>, <big>maior</big> e <br> para quebrar linha.')
ON CONFLICT (key) DO NOTHING;
