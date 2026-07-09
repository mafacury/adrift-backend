-- Presente deixado junto com uma mensagem (Etapa 3).
-- Guarda só o código do presente; o catálogo vive no código (services/gifts.ts).
ALTER TABLE boat_messages
  ADD COLUMN IF NOT EXISTS gift_id TEXT;
