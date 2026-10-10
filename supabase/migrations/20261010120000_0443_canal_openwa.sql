-- 0443 · Canal de WhatsApp OpenWA — serviço self-hosted HTTP (`@open-wa/wa-automate`,
-- Easy API v5), canal NÃO-OFICIAL e opt-in da instalação.
--
-- ─── O que entra ────────────────────────────────────────────────────────────
-- Um provedor de canal de mensagem novo, ao lado de `waha`, `meta_cloud`,
-- `zernio`, `zernio_social` e `datafy`. O OpenWA roda FORA do app como um
-- serviço HTTP separado; a fronteira é o adapter em `lib/channels/openwa/` e
-- nenhuma linha de código dele é embutida aqui. A coluna de referência é o
-- NOME DA SESSÃO do serviço (`--session-id` do CLI): um serviço = uma sessão.
--
-- A credencial é POR ORGANIZAÇÃO, no mesmo desenho do canal oficial (0118):
-- `openwa_base_url` + `openwa_api_key_encrypted` na linha da sessão, cifrada
-- pelas RPCs `fn_encrypt_oauth`/`fn_decrypt_oauth`. A resolução é FALHA-
-- FECHADA sob escopo de organização e mora em
-- `lib/channels/openwa/credentials.ts`: a base da linha passa pela allowlist
-- da instalação (`OPENWA_ALLOWED_ORIGINS`), e o env só serve no modo
-- single-tenant explícito (`OPENWA_SINGLE_TENANT=1` + `OPENWA_SINGLE_TENANT_ORG_ID`
-- dono + `OPENWA_SESSION_NAME` igual ao sessionRef; mesmo sem escopo nenhum o
-- env exige a flag) — NUNCA como socorro de uma resolução de organização que
-- falhou (a lição da issue #236).
--
-- ─── Por que recriar os CHECKs inteiros ─────────────────────────────────────
-- Mesmo desenho da 0131/0387: drop+add (nunca `exception when duplicate_object`).
-- O vocabulário abaixo é o da 0387 mais `openwa`. Alargamento puro nos três
-- CHECKs: um CHECK que aceita mais valores não é violado por linha que já
-- passava pelo antigo, então não há backfill antes.

alter table public.channel_sessions
  add column if not exists openwa_session_name text;

comment on column public.channel_sessions.openwa_session_name is
  'Nome da sessão do serviço OpenWA (--session-id do CLI @open-wa/wa-automate). É o sessionRef deste canal. Espelhado em lib/channels/session-ref.ts.';

alter table public.channel_sessions
  add column if not exists openwa_base_url text;

comment on column public.channel_sessions.openwa_base_url is
  'Base do serviço OpenWA DESTA organização; precisa estar na allowlist da instalação (OPENWA_ALLOWED_ORIGINS). Nula = openwa_base_invalida no envio: linha existente NUNCA cai no env (falha fechada).';

alter table public.channel_sessions
  add column if not exists openwa_api_key_encrypted bytea;

comment on column public.channel_sessions.openwa_api_key_encrypted is
  'X-API-Key do serviço OpenWA desta organização, cifrada por fn_encrypt_oauth. Nula = openwa_sessao_sem_credencial: linha existente NUNCA cai no env (falha fechada). O env só serve no modo single-tenant declarado (OPENWA_SINGLE_TENANT=1 + OPENWA_SINGLE_TENANT_ORG_ID dono + OPENWA_SESSION_NAME igual ao ref) ou sem escopo nenhum.';

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
    check (provider in ('waha', 'meta_cloud', 'zernio', 'zernio_social', 'wacalls', 'datafy', 'openwa'));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha' and waha_session_name is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls' and wacalls_session_id is not null) or
    (provider = 'datafy' and datafy_phone_number_id is not null) or
    (provider = 'openwa' and openwa_session_name is not null)
  );

alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;

alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'datafy', 'openwa'
  ));

notify pgrst, 'reload schema';
