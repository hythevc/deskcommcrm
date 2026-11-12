# Medição — GHSA-3h4r-cw6m-fcv9 (e nota da 1.32.1)

Evidência de verificação isolada. Sem dado de instalação, sem credencial, sem
deploy. Os IDs abaixo são sintéticos.

Publicado em: https://github.com/melgarafael/DeskcommCRM/security/advisories/GHSA-3h4r-cw6m-fcv9

## Pins (2026-10-10)

| Ref | SHA |
|---|---|
| `HEAD` deste clone (fork `main`) | `f322ca41bc40c538803b173d7ce0003143df793b` |
| `git describe` | `v1.57.0-1-gf322ca41b` |
| tag `v1.57.0` (objeto) | `dd2a8663a8607e6aaa95af2c8ebfc53e4762d21c` |
| `v1.57.0^{}` (merge da release) | `6206bca728a3762f42add7c5773a3a39c4c35abc` |
| #1821 — guarda de conta no WhatsApp intermediado | `a3e298feade5daa8b05f0da6dda2c39151c46f95` |
| #1823 — evento sem conta / número só do próprio canal | `27dace84969f2614781f9aa096a1a5198d99d12a` |
| tag `v1.32.1` (objeto, após fetch do upstream) | `3a81e4c2eb1f124eb5c49584c763de9b1aff37d9` |
| `upstream/main` (`melgarafael/DeskcommCRM`) | `048c94b040f2cdfa34f90e5d422ac25227c81adf` |
| tag `v1.79.0^{}` (última release medida no upstream) | `c51f5ea8170bc9bb946f00846bb1a130aa408579` |

```
git merge-base --is-ancestor a3e298feade5daa8b05f0da6dda2c39151c46f95 HEAD  # 1821 in HEAD
git merge-base --is-ancestor 27dace84969f2614781f9aa096a1a5198d99d12a HEAD  # 1823 in HEAD
git merge-base --is-ancestor v1.57.0 HEAD                                   # 1.57.0 in HEAD
git rev-list --count HEAD..upstream/main                                    # 3696
```

O fork **já está em ≥ 1.57.0**. Os consertos do advisory estão no histórico.
Não se mesclou o restante do upstream (1.58.0–1.79.0, 3696 commits): isso é
atualização de produto, não o recorte do advisory, e pede decisão de quem
opera a instalação.

## O que se mediu (CONFIRMADO)

1. **Versão do código:** `v1.57.0-1-gf322ca41b` ≥ 1.57.0 (versão corrigida do
   advisory). O commit extra depois da tag é
   `chore(ci): disable Dependabot version updates`.
2. **Consultas Q1/Q2/Q3 do advisory** num Postgres 16 local, descartável,
   sem Docker e sem o `baseline.sql` completo (este ambiente não tem Docker /
   `pgvector`). As tabelas tinham só as colunas que as consultas leem.
   Banco criado, consultado e **apagado** na mesma sessão.
3. Banco vazio: Q1 = 0, Q2 = 0, Q3 = 0. Saída em `consultas.out`.
4. Controle sintético (dois tenants inventados, mesma mensagem/conversa):
   Q1 `entre_organizacoes=t`; Q2 e Q3 devolvem 1 grupo com 2 orgs. As
   consultas detectam o formato de vazamento que o advisory descreve.
5. Testes do conserto no código (dublê, sem banco):
   `pnpm vitest run tests/unit/whatsapp-canal-intermediado-so-da-sua-conta.test.ts tests/unit/canal-intermediado-evento-sem-conta-e-numero.test.ts tests/unit/assinatura-recusada-deixa-rastro.test.ts`
   → `Test Files  3 passed (3)` / `Tests  21 passed (21)` / `exit=0`.
6. **GHSA-vm36-w42w-rr5v (1.32.1):** o kit neste SHA já grava
   `curl -H @"…/.env.cron-drain"` em `hostgator-setup-kit/_common.sh`.
   `bash tests/shell/senha-do-cron-vazada.test.sh` →
   `✓ senha do cron vazada: todos os casos passaram` / `exit=0`.
   Esse teste **simula** `update.sh` em sandbox (dublê de crontab/docker).
   **Não** se rodou `update.sh` em VPS, produção ou instalação real.

## NÃO MEDIDO

- Nenhuma instalação real. As consultas vazias **não** dizem se algum tenant
  desta operação já foi alcançado — só que o banco isolado desta sessão
  estava vazio e que as consultas disparam no controle sintético.
- `pnpm test:db` / aplicação do `supabase/baseline.sql` completo: este
  ambiente não tem Docker.
- `pnpm test:e2e`, `pnpm typecheck`, `pnpm lint`, suíte unitária inteira.
- Crontab de host, syslog, journal, rotação de `INTERNAL_CRON_SECRET`,
  filtro `accountIds` no provedor intermediado.
- Qualquer VPS. A nota da 1.32.1 (“rode o `update.sh` duas vezes”) é ação
  de quem opera o servidor único — não foi executada aqui.

## O que quem opera ainda precisa decidir

- Se a instalação passou pela 1.32.1 (ou veio de antes): no **servidor**,
  `bash hostgator-setup-kit/update.sh` **duas vezes**, depois
  `crontab -l | grep -c -- '-H @'` tem de ser `1`. Rotacionar
  `INTERNAL_CRON_SECRET` (e `INTERNAL_SECRET` se o primeiro estava vazio) e
  considerar expurgar logs antigos. Isto **não** foi feito aqui.
- Preencher `accountIds` na inscrição de webhook do provedor intermediado
  (mitigação do GHSA-3h4r; o código/tela ainda não usam esse filtro).
- Se e quando trazer o fork de 1.57.0 para o upstream atual (1.79.0): config,
  segredo, imagem e janela de deploy. Fora deste PR.
- Rodar Q1–Q3 contra o banco **da instalação** só o operador pode fazer.
  Este PR não aponta e não consulta esse banco.
