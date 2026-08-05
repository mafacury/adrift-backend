-- O baú deixa de ser uma lista de permissões e vira um estoque.
--
-- Até aqui um presente era destravado ou não: destravou, dava para sempre,
-- quantas vezes quisesse. Isso torna impossível vender pacote — ninguém compra
-- o que já tem infinito — e, pior, tira o peso do gesto: um presente que não
-- custa nada não diz nada.
--
-- Agora há duas coisas separadas:
--   • DESTRAVAR  — o direito de possuir aquele presente, vem das conquistas
--   • QUANTIDADE — quantos você tem para dar, e cada um dado sai do baú
--
-- Os presentes de boas-vindas ficam INFINITOS de propósito (ver services/
-- gifts.ts): ninguém pode ficar sem nada para retribuir, senão o app deixa de
-- ser generoso quando o estoque acaba — e a generosidade é o produto.
CREATE TABLE IF NOT EXISTS gift_inventory (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gift_id    TEXT NOT NULL,
  quantity   INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, gift_id)
);

-- Registro de que uma origem já rendeu o seu estoque inicial.
-- Sem isto, cada consulta ao baú entregaria de novo os presentes das mesmas
-- conquistas — as conquistas são CALCULADAS, então "já cumprida" é para sempre.
-- A chave é livre ('achv:fleet', 'pack:abc123') para servir também às compras.
CREATE TABLE IF NOT EXISTS gift_grants (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, source_key)
);

CREATE INDEX IF NOT EXISTS gift_inventory_user_idx ON gift_inventory (user_id);
