# Ponto de restauração — 18/08/2026 — alertas de chegada

## O problema

Relato do dono: barco a ~3000mn de manhã, foi trabalhar, voltou e o barco tinha
sumido. Nenhum aviso de chegada, nenhum aviso de perda.

A investigação mostrou que não faltava UM alerta — faltava o canal inteiro:

- `registerForPush` sai na primeira linha na web (`if (Platform.OS === 'web') return`),
  então `users.fcm_token` é NULL e `sendPushToUser` nunca envia nada.
- O único aviso na web vem de um vigia dentro do app (`_layout.tsx`), que só roda
  com a ABA ABERTA. Aba fechada = silêncio total.
- `boatArrivedMessage()` existia em `push.ts` e NUNCA era chamada — escrita e
  esquecida.
- A expiração da fila é silenciosa: o scheduler vira o status e reroteia.
- `reengageSweep` só alcança quem está 8 dias inativo.

## O que muda

| | Antes | Depois |
| --- | --- | --- |
| canal na web (aba fechada) | nenhum | Web Push (VAPID + service worker) |
| aviso de partida | push (só APK) | mantido |
| aviso de CHEGADA | **nenhum** | push em todos os canais |
| aviso de prazo acabando | **nenhum** | 2h antes de expirar |
| aviso de PERDA | **nenhum** | ao expirar, dizendo para onde foi |
| janela de resposta | 12h | 12h (inalterada — decisão do dono) |

## Arquivos tocados (cópias `.bak` nesta pasta)

- `src/services/push.ts` — vira fanout de canais
- `src/services/scheduler.ts` — três varreduras novas
- `src/services/routing.ts`
- `src/config/index.ts`
- `src/routes/users.ts`
- `mobile/services/push.ts`, `mobile/app/(main)/_layout.tsx` (em `mobile/backups/2026-08-18-alertas/`)

Novos (para desfazer, apagar):
- `src/services/notify.ts`
- `src/db/migrations/026_web_push.sql`
- `mobile/public/sw.js`

## Rollback

```bash
cd "i:/Meu Drive/Adrift/adrift/backend"
git reset --hard c1caeb8      # "fix: limite de taxa responde 429, nao 500"
```

A migração 026 só cria tabela nova; voltar o código não exige desfazer o banco.
