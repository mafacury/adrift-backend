# Ponto de restauração — 18/08/2026 — defesas antispam

## O que vai mudar e por quê

A auditoria de segurança mostrou que o Adrift defende bem o **conteúdo** (blocklist
+ IA em duas camadas) e não defende nada a **conta**: criar usuário é grátis e
ilimitado, uma conta lança barcos sem teto, e o `moderation_log` registra tudo sem
que ninguém leia. Um bot cria mil contas e despeja propaganda até alguém ver.

São cinco mudanças, do mais barato ao mais caro:

1. **Falha aberta no varredor** — `sweepStrandedBoats` solta barco SEM log de
   moderação. Se a chamada à Anthropic der erro, nenhuma linha entra em
   `moderation_log`, e o `NOT EXISTS (verdict IN ('rejected','uncertain'))` é
   verdadeiro. O barco navega sem nunca ter sido moderado. Passa a exigir
   `EXISTS (verdict = 'approved')` — falha fechada.
2. **Teto de barcos por conta** — hoje não existe nenhum.
3. **Banimento automático por histórico** — lê o `moderation_log` que já existe.
4. **Limite de taxa por IP + CAPTCHA no cadastro.**
5. **Verificação de e-mail.**

## Antes / depois das constantes

| Constante | Antes | Depois | Onde |
| --- | --- | --- | --- |
| filtro do varredor | `NOT EXISTS (verdict IN ('rejected','uncertain'))` | `EXISTS (verdict = 'approved')` | `services/process.ts` |
| barcos ativos por conta | sem teto | `MAX_ACTIVE_BOATS_PER_USER = 3` | `config/index.ts` |
| intervalo entre lançamentos | nenhum | `LAUNCH_COOLDOWN_SEC = 120` | `config/index.ts` |
| rejeições até pausar | — | `AUTOBAN_PAUSE_AT = 3` em 24h | `config/index.ts` |
| rejeições até banir | — | `AUTOBAN_BAN_AT = 5` em 24h | `config/index.ts` |
| limite de taxa | nenhum | 120 req/min por IP; 10/min nas rotas com bcrypt | `index.ts` |
| CAPTCHA | nenhum | Turnstile, ativo só com `TURNSTILE_SECRET` | `services/captcha.ts` |
| verificação de e-mail | nenhuma | ativa só com `REQUIRE_EMAIL_VERIFICATION=true` | `routes/auth.ts` |

## Arquivos tocados (cópias `.bak` nesta pasta)

- `src/config/index.ts`
- `src/services/process.ts`
- `src/services/moderation.ts`
- `src/services/mail.ts`
- `src/routes/boats.ts`
- `src/routes/auth.ts`
- `src/index.ts`
- `package.json`
- `mobile/app/(auth)/register.tsx` (cópia em `mobile/backups/2026-08-18-antispam/`)
- `mobile/services/api.ts` (idem) — passou a preferir `message` a `error` na frase de erro
- `mobile/context/auth.tsx` — `register()` agora devolve `{ precisaVerificar }`

Arquivos NOVOS criados (para desfazer, basta apagar):
- `src/services/enforcement.ts`
- `src/services/captcha.ts`
- `src/lib/rate-limit.ts`
- `src/db/migrations/025_antispam.sql`
- `mobile/components/captcha.tsx`

Nada foi apagado.

## Rollback

O repositório do backend estava **limpo** no commit `4c6c1ab`
("chore: /health diz o commit e a hora em que o processo subiu"). O caminho mais
curto é o git:

```bash
cd "i:/Meu Drive/Adrift/adrift/backend"
git reset --hard 4c6c1ab
git push --force-with-lease origin main     # só se a mudança já tiver subido
```

Sem git (ou para voltar só um arquivo), as cópias desta pasta:

```bash
cd "i:/Meu Drive/Adrift/adrift/backend"
cp backups/2026-08-18-antispam/src_services_process.ts.bak src/services/process.ts
# e assim por diante — o nome do .bak é o caminho com '/' virando '_'
```

A migração 025 cria tabela e coluna novas; ela não altera nem apaga nada do que
já existe, então voltar o código não exige desfazer o banco.

O `mobile` não tem histórico utilizável (um único commit, resto sem commitar) —
para ele, vale só a cópia `.bak`.
