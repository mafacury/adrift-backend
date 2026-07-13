-- Sinal de "escrevendo...": o app do receptor humano avisa enquanto a pessoa
-- digita a resposta, e o criador do barco vê o indicador ao vivo no mapa.
ALTER TABLE receiver_queue ADD COLUMN IF NOT EXISTS typing_at TIMESTAMPTZ;
