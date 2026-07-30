-- Cache de tradução das mensagens.
--
-- A chave é o HASH DO TEXTO, não o id da mensagem, e por um motivo prático: a
-- mesma mensagem viaja para muita gente. Se a chave fosse a mensagem, cada
-- pessoa que abrisse o mesmo barco pagaria uma tradução nova do mesmo texto.
-- Pelo conteúdo, cada frase do app é traduzida UMA vez para cada idioma, para
-- sempre — e quem chegar depois lê de graça e na hora.
--
-- Não guarda quem pediu nem para qual barco: é um dicionário de frases.
CREATE TABLE IF NOT EXISTS message_translations (
  content_hash TEXT NOT NULL,          -- sha256 do texto original
  lang         TEXT NOT NULL,          -- idioma de destino ('pt')
  translated   TEXT NOT NULL,
  source_lang  TEXT,                   -- idioma detectado, só para exibir
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (content_hash, lang)
);
