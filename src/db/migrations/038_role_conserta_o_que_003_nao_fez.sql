-- A coluna `role` nunca ficou como a migração 003 mandou.
--
-- 003_admin_role.sql, de 30/06/2026, diz:
--
--     ALTER TABLE users
--       ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'
--         CHECK (role IN ('user', 'admin'));
--
-- Ela está registrada como aplicada. Mas em produção a coluna é NULLABLE, o
-- DEFAULT é '20' e não existe CHECK nenhum — e 40 contas estão com o valor
-- literal '20' no lugar de 'user'.
--
-- O culpado é o `IF NOT EXISTS`: a coluna JÁ EXISTIA quando 003 rodou (criada
-- fora das migrações, com aquele default estranho), então o comando inteiro
-- virou um no-op silencioso. `ADD COLUMN IF NOT EXISTS` não confere se a
-- coluna existente é igual à que você descreveu — ele só olha o nome. O NOT
-- NULL, o DEFAULT e o CHECK nunca chegaram ao banco, e a migração passou como
-- bem-sucedida.
--
-- Nada quebrou até hoje porque o código só pergunta `role !== 'admin'`, e '20'
-- não é 'admin'. Funciona por acidente: no dia em que alguém escrever
-- `role === 'user'` — que é o que a migração 003 promete — a comparação falha
-- em 40 contas e ninguém vai entender por quê.
--
-- Esta migração termina o serviço de 003. Não apaga a coluna: é ela que separa
-- admin de usuário comum, e sem ela o login inteiro para de funcionar (o
-- SELECT de auth.ts pede `role` pelo nome).

-- 1. os 40 '20' viram 'user'. Qualquer valor que não seja 'admin' é usuário
--    comum — inclusive NULL, que a coluna permitia.
UPDATE users SET role = 'user'
 WHERE role IS DISTINCT FROM 'admin';

-- 2. o DEFAULT que 003 pedia, para conta nova não nascer torta de novo
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user';

-- 3. sem nulo: a coluna decide permissão, e "não sei" não é uma permissão
ALTER TABLE users ALTER COLUMN role SET NOT NULL;

-- 4. a trava que 003 pedia. Com ela, '20' não entra nunca mais — nem por
--    migração, nem por painel do banco, nem por dedo escorregado.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'));
  END IF;
END $$;
