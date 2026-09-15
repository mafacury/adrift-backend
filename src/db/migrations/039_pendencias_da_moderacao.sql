-- 039 — o que ainda espera a moderação humana
--
-- O painel sabe tudo e não conta nada. Em 14/09/2026 um barco de uma usuária
-- nova foi recolhido pela moderação por engano, e a única razão de alguém ter
-- descoberto foi uma pergunta feita à mão, cinco horas depois: "por que o
-- painel diz 1 barco e a tela dela não mostra nenhum?".
--
-- Daqui sai o aviso do menu — um número no ícone do Perfil, só para a conta
-- de administrador. Ele soma três coisas, e todas as três têm algo a FAZER:
--
--   1. barco parado esperando julgamento humano (`status = 'paused'`)
--   2. denúncia de usuário em aberto
--   3. barco que o robô recolheu e que o admin ainda não olhou
--
-- O item 3 é o que exige esta coluna. Os dois primeiros se apagam sozinhos
-- quando resolvidos; o terceiro não tem "resolvido" — o barco já foi
-- arquivado, não há botão que o tire da conta. Sem uma marca de "já vi até
-- aqui", o número acenderia para sempre depois da primeira recusa.
--
-- ── Por que na conta, e não numa chave global ──────────────────────────────
--
-- Cabe em `system_settings` com uma chave só, e hoje daria no mesmo: há um
-- administrador. Mas "até onde EU já olhei" é fato de pessoa, não do sistema,
-- e no dia em que houver um segundo administrador a chave global faria o
-- primeiro a abrir a tela apagar o aviso do outro. A coluna custa o mesmo e
-- não tem esse dia ruim.
--
-- Nula quer dizer "nunca abriu a tela", e aí tudo que a moderação recolheu
-- conta. É o começo certo: quem nunca olhou tem tudo por olhar.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS moderacao_vista_em TIMESTAMPTZ;

COMMENT ON COLUMN users.moderacao_vista_em IS
  'Última vez que este admin abriu a tela de Moderação. NULL = nunca abriu.';

-- A contagem pergunta "recolhidos depois de tal instante". São dez linhas hoje
-- e o índice é quase de graça, mas ele é o que mantém a conta barata quando a
-- tabela crescer — ela roda a cada 60 segundos enquanto o painel estiver
-- aberto.
CREATE INDEX IF NOT EXISTS boats_moderados_idx
  ON boats (archived_at)
  WHERE archive_reason = 'moderado';
