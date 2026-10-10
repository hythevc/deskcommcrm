/**
 * Credenciais do canal OpenWA — **por sessão**, com falha FECHADA.
 *
 * Clone declarado do molde de `lib/channels/meta/credentials.ts`, com UMA
 * diferença de postura: aqui o fallback de ambiente NÃO socorre uma resolução
 * de organização que falhou.
 *
 * ─── Por que falha fechada, e o irmão não ──────────────────────────────────
 *
 * Na Meta, cair no env depois de uma sessão sem token é a transição histórica
 * tolerada (a tela de conexão gravava depois do env existir). Aqui a história
 * é outra: a credencial do OpenWA é a chave de um serviço que manda mensagem
 * em nome da organização, e a do `.env` é a chave de um serviço que PODE SER
 * DE OUTRA ORGANIZAÇÃO (a instalação hospeda N). "A sessão dela não tem
 * credencial, manda pelo serviço da instalação" é a mensagem da Maria saindo
 * pelo número da Joana — a classe exata de defeito que a issue #236 pagou no
 * canal oficial. Então:
 *
 *   - COM escopo de organização (`organizationId` ou `sessionRef` presentes):
 *     a credencial vem da linha de `channel_sessions` DAQUELA organização, e
 *     QUALQUER falha LANÇA com código nomeado — escopo vazio
 *     (`openwa_sem_escopo_de_organizacao`), sessão inexistente ou arquivada
 *     (`openwa_sessao_nao_encontrada`), linha sem chave gravada
 *     (`openwa_sessao_sem_credencial`), decifra impossível
 *     (`openwa_credencial_ilegivel`), base reprovada no portão de SSRF
 *     (`openwa_base_invalida`), consulta quebrada
 *     (`openwa_creds_lookup_failed`). NENHUMA delas cai no env.
 *   - SEM escopo nenhum (os dois ausentes): é o MODO SINGLE-TENANT EXPLÍCITO —
 *     instalação autohospedada de serviço único que escolheu viver do
 *     `OPENWA_API_BASE_URL`/`OPENWA_API_KEY` do ambiente. O env só é lido
 *     aqui.
 *
 * ─── A base do banco é ENTRADA, e passa por um portão mais estreito ────────
 *
 * `openwa_base_url` gravada na linha não é ambiente do operador: é string que
 * um dia vem de uma tela. Ela passa por `baseDeSessaoAceita` (`./client.ts` —
 * https obrigatório, sem literal de IP, sem userinfo, porta 443 ou allowlist),
 * que fecha o SSRF "aponte a base para o metadata da nuvem e a chave vai
 * junto". Reprovada → `openwa_base_invalida`, nunca env.
 *
 * A chave em si é cifrada pelas MESMAS RPCs do resto do repo
 * (`fn_encrypt_oauth`/`fn_decrypt_oauth`, `lib/webhooks/secrets.ts`) — um
 * segundo caminho de cifra seria mais um lugar para ela vazar. E a busca leva
 * `organization_id=eq.` À MÃO: este client é service role e bypassa RLS, e o
 * `error` do PostgREST NUNCA é descartado (a lição da #236: `maybeSingle()`
 * com duas linhas devolve `data: null` COM erro, PGRST116).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";

import { baseAceita, baseDeSessaoAceita } from "./client";

export interface OpenwaCredentials {
  /** Base absoluta do serviço — do banco passou por `baseDeSessaoAceita`; do env, por `baseAceita`. */
  baseUrl: string;
  apiKey: string;
  /** O `sessionRef` deste canal (`channel_sessions.openwa_session_name`). */
  sessionName: string;
  /** De onde veio — aparece no log de diagnóstico, nunca no payload. */
  source: "session" | "env";
}

/** A chave da busca. `organizationId` NÃO é decoração: ver o cabeçalho. */
export interface OpenwaCredsLookup {
  /** Resolvido de fonte confiável (sessão, linha já escopada, token do webhook). */
  organizationId: string;
  /** `channel_sessions.openwa_session_name` — o `sessionRef` deste canal. */
  sessionRef: string;
}

/**
 * Credencial do AMBIENTE — só é consultada no modo single-tenant explícito
 * (ver `resolveOpenwaCreds`). `null` quando não configurada.
 */
export function openwaCredsFromEnv(): OpenwaCredentials | null {
  const baseUrl = baseAceita(process.env.OPENWA_API_BASE_URL);
  const apiKey = process.env.OPENWA_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey, sessionName: process.env.OPENWA_SESSION_NAME?.trim() || "default", source: "env" };
}

/**
 * Credencial da sessão desta ORGANIZAÇÃO — ou ERRO. Não existe `null` aqui:
 * toda saída sem credencial é um lançamento nomeado, porque neste modo o env
 * é a conta de OUTRA organização e fallback seria o defeito da #236.
 */
export async function openwaCredsForSession(
  admin: SupabaseClient,
  lookup: OpenwaCredsLookup,
): Promise<OpenwaCredentials> {
  const { organizationId, sessionRef } = lookup;
  if (!organizationId) throw new Error("openwa_sem_escopo_de_organizacao");
  if (!sessionRef) throw new Error("openwa_sessao_sem_ref");

  // A ordem das perguntas é a correção de um defeito real: ARQUIVADA +
  // substituta ATIVA com o MESMO ref (a reconexão normal) derruba o
  // `maybeSingle()` sem filtro em PGRST116 — e a sessão nova, válida, não
  // enviava NADA. Então:
  //
  //   1. A ATIVA primeiro: `archived_at is null` + `maybeSingle()`. ZERO é
  //      "não há ativa"; UMA é a resposta; DUAS OU MAIS ativas com o mesmo
  //      ref é PGRST116 — ambiguidade de credencial, FALHA FECHADA (nunca
  //      "pega a primeira": escolher arbitrariamente é mandar pela conta
  //      errada metade das vezes).
  //   2. Sem ativa, a pergunta é de EXISTÊNCIA: há ARQUIVADA com este ref?
  //      Sim → `openwa_sessao_arquivada` (existente-e-desligada: o resgate
  //      do single-tenant NÃO cobre — senão arquivar viraria "mandar pela
  //      chave do .env"). Não → `openwa_sessao_nao_encontrada` (o ÚNICO erro
  //      resgatável). O `limit(1)` aqui é de propósito: VÁRIAS arquivadas
  //      são o mesmo fato, não ambiguidade.
  //
  // A tolerância a coluna ausente (banco sem a 0106) cobre as duas: sem a
  // coluna NADA está arquivado, e a consulta sem filtro é a resposta exata
  // — ver `../archived.ts`.
  const base = (cols: string) =>
    admin
      .from("channel_sessions")
      .select(cols)
      .eq("organization_id", organizationId)
      .eq("provider", "openwa")
      .eq("openwa_session_name", sessionRef);
  const COLS_CRED = "openwa_session_name, openwa_base_url, openwa_api_key_encrypted";
  const falhaNaConsulta = (error: { code?: string | null } | null) => {
    // Só o CÓDIGO (PGRST116, 42703…), nunca `error.message`: a mensagem do
    // PostgREST pode carregar valor de coluna, e `lib/logger` proíbe propagar
    // dado que não é nosso. A causa fica para quem tem acesso ao banco.
    throw new Error(`openwa_creds_lookup_failed: ${error?.code || "sem_codigo"}`);
  };

  const ativa = await queryTolerantToMissingArchived(
    () => base(COLS_CRED).is(ARCHIVED_AT, null).maybeSingle(),
    () => base(COLS_CRED).maybeSingle(),
  );
  if (ativa.error) falhaNaConsulta(ativa.error);

  const data = ativa.data;
  if (!data) {
    if (ativa.schemaOutdated) {
      // Sem a coluna NADA está arquivado: ausente é ausente.
      throw new Error("openwa_sessao_nao_encontrada");
    }
    const arquivada = await base("openwa_session_name").not(ARCHIVED_AT, "is", null).limit(1);
    if (arquivada.error) falhaNaConsulta(arquivada.error);
    if (!arquivada.data || arquivada.data.length === 0) {
      throw new Error("openwa_sessao_nao_encontrada");
    }
    throw new Error("openwa_sessao_arquivada");
  }

  const baseUrl = baseDeSessaoAceita(data.openwa_base_url as string | undefined);
  if (!baseUrl) throw new Error("openwa_base_invalida");

  const cifrado = data.openwa_api_key_encrypted;
  if (!cifrado) throw new Error("openwa_sessao_sem_credencial");

  const apiKey = await decryptWebhookSecret(admin, cifrado as unknown as string);
  // Decifra que falha (GUC ausente, chave trocada) NÃO pode cair no env: a
  // organização TEM credencial gravada, ela é que está ilegível — mandar pela
  // conta da instalação esconderia isso e sairia pelo serviço errado.
  if (!apiKey) throw new Error("openwa_credencial_ilegivel");

  return {
    baseUrl,
    apiKey,
    sessionName: data.openwa_session_name as string,
    source: "session",
  };
}

/**
 * A credencial em vigor, com a fronteira de modo no LUGAR CERTO:
 *
 *   - escopo de organização presente → sessão, falha fechada (LANÇA);
 *   - escopo totalmente ausente → modo single-tenant explícito: o env, e só
 *     ele (`null` = não configurado; o chamador nomeia `openwa_nao_configurado`).
 */
/**
 * A instalação DECLAROU que tem um único serviço OpenWA? O legado só é
 * legítimo quando TODOS os elos se alinham — e cada elo existe porque sem ele
 * a chave do `.env` serviria a quem não deve:
 *
 *   - `OPENWA_SINGLE_TENANT=1`: a declaração explícita. Sem ela, o env não é
 *     credencial de envio para NINGUÉM — nem sem escopo.
 *   - `OPENWA_SINGLE_TENANT_ORG_ID`: a organização DONA do serviço do env.
 *     Obrigatório com a flag (flag sem dono não declara nada); um pedido com
 *     `organizationId` de OUTRA organização não é servido — duas organizações
 *     sem linha própria NÃO podem cair no mesmo env.
 *   - `OPENWA_SESSION_NAME` == `sessionRef` pedido (quando há ref): sem o
 *     nome casar, o env poderia estar apontando para a sessão de outra
 *     organização — o defeito que a flag existe para delimitar.
 */
function modoSingleTenantDeclarado(lookup: OpenwaCredsLookup): boolean {
  if (process.env.OPENWA_SINGLE_TENANT !== "1") return false;
  const orgId = process.env.OPENWA_SINGLE_TENANT_ORG_ID?.trim();
  if (!orgId) return false;
  if (lookup.organizationId && lookup.organizationId !== orgId) return false;
  if (lookup.sessionRef) {
    const nome = process.env.OPENWA_SESSION_NAME?.trim();
    if (!nome || nome !== lookup.sessionRef) return false;
  }
  return true;
}

export async function resolveOpenwaCreds(
  admin: SupabaseClient,
  lookup: OpenwaCredsLookup,
): Promise<OpenwaCredentials | null> {
  if (lookup.organizationId || lookup.sessionRef) {
    try {
      return await openwaCredsForSession(admin, lookup);
    } catch (err) {
      // O ÚNICO resgate: instalação single-tenant DECLARADA (org + nome
      // amarrados), e só para SESSÃO INEXISTENTE — a configuração legada,
      // pré-tela. Linha ARQUIVADA, com decifra quebrada ou base hostil NÃO é
      // resgatada: a linha existe, a falha é real.
      if (
        err instanceof Error &&
        err.message.startsWith("openwa_sessao_nao_encontrada") &&
        modoSingleTenantDeclarado(lookup)
      ) {
        return openwaCredsFromEnv();
      }
      throw err;
    }
  }
  // Sem escopo nenhum: o env ainda exige a declaração — um env esquecido não
  // pode virar credencial ambulante de qualquer chamador sem organização.
  if (!modoSingleTenantDeclarado(lookup)) return null;
  return openwaCredsFromEnv();
}
