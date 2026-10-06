-- 043 — compartilhar a jornada nas redes (06/10/2026)
--
-- Duas peças.
--
-- 1) A LICENÇA de cada mensagem. Quem escreve marca (ou não) "permito que
--    minha mensagem seja publicada no contexto do Adrift", e só o que foi
--    marcado aparece na página pública do barco (/j/:id).
--
--    Nula de propósito, e não FALSE por padrão. São três estados:
--      TRUE  — a pessoa marcou;
--      FALSE — a pessoa viu a caixa e deixou desmarcada;
--      NULL  — a mensagem é de antes da caixa existir, ou é de um bot.
--    O NULL é o que mantém de pé a frase do DONO nas páginas que já foram
--    compartilhadas: ela sempre apareceu ali, e sumir com ela de um dia para o
--    outro mudaria links que já estão no WhatsApp das pessoas. Para as
--    mensagens de terceiros só vale TRUE — ninguém nunca foi perguntado antes.
ALTER TABLE boat_messages ADD COLUMN publicavel BOOLEAN;

-- 2) A imagem do mapa com a rota, para o cartão do link. O desenho é feito no
--    navegador de quem compartilha (o mesmo pergaminho e a mesma projeção do
--    Mapa) e enviado para cá; a página /j/:id a oferece como og:image, então o
--    link colado no WhatsApp, Facebook ou LinkedIn vira um cartão com a rota.
--    Uma por barco, regravada a cada compartilhamento.
CREATE TABLE boat_share_images (
  boat_id    UUID PRIMARY KEY REFERENCES boats(id) ON DELETE CASCADE,
  jpeg       BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
