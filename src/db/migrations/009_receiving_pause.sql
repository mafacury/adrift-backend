-- Pausa de recebimento: quando ligado, o usuário não é escolhido como
-- receptor de novos barcos (os que já estão a caminho/na fila continuam).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS receiving_paused BOOLEAN NOT NULL DEFAULT FALSE;
