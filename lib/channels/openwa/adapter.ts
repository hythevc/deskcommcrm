/**
 * Adapter OpenWA — o canal não-oficial self-hosted atrás do seam.
 *
 * Burro de propósito, como os irmãos: traduz formato e nada mais (doutrina
 * `restricao-de-canal.md`). Janela, throttle, warm-up e cap são da cadeia
 * `before_send` — a matriz (`capabilities.ts`) já declara `banRisk: true`.
 *
 * ─── O que este adapter NÃO faz, de propósito ─────────────────────────────
 *
 *   - Mídia e cartão de contato: o v1 manda TEXTO. Um `kind` fora disso LANÇA
 *     `openwa_kind_nao_suportado` em vez de mandar metade silenciosamente — o
 *     handler grava a falha com o motivo, e a mensagem não sai fingindo ser
 *     o que não é.
 *   - Template: canal não-oficial não tem definição aprovada
 *     (`requiresTemplates: false`), então `sendTemplate` não é implementado —
 *     quem chama testa a presença do método, como manda o seam.
 *   - Roteamento por `sessionRef` DENTRO do serviço: um serviço OpenWA é UMA
 *     sessão; o ref identifica a linha de `channel_sessions` (é ele que acha
 *     a credencial), não muda a chamada HTTP.
 *
 * ─── Credencial por ORGANIZAÇÃO, com falha FECHADA ─────────────────────────
 *
 * A credencial vive na linha de `channel_sessions` da organização
 * (`./credentials.ts`). Com escopo de organização no envelope, QUALQUER falha
 * de resolução LANÇA com código nomeado — nunca cai no env, porque a chave do
 * `.env` pode ser a do serviço de OUTRA organização (a lição da issue #236).
 * O env só é lido no modo single-tenant explícito (escopo totalmente
 * ausente). Por isso `isConfigured` não tem resposta síncrona honesta e quem
 * desiste é o `send`, para o handler gravar o motivo em vez de um
 * `{externalId: null}` que diria "enviado" para algo que nunca saiu.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { DETALHE_CREDENCIAL_RECUSADA } from "../health";
import type { ChannelAdapter, ChannelHealth, ChannelTenantScope, OutboundEnvelope, RecipientInput } from "../types";
import { OpenwaClient } from "./client";
import { resolveOpenwaCreds } from "./credentials";

/** Só dígitos + sufixo de conversa individual: `+55 31 99999-0000` → `5531999990000@c.us`. */
export function chatIdDoTelefone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  return digits.length > 0 ? `${digits}@c.us` : null;
}

export const openwaAdapter: ChannelAdapter = {
  provider: "openwa",

  resolveRecipient(input: RecipientInput): string | null {
    // Grupo: o id já vem endereçado pelo provider (`…@g.us`); aceitar outra
    // coisa seria montar um endereço que o serviço recusaria.
    if (input.isGroup) {
      const g = input.groupChatId?.trim();
      return g && g.endsWith("@g.us") ? g : null;
    }
    if (!input.phoneNumber) return null;
    return chatIdDoTelefone(input.phoneNumber);
  },

  /**
   * SEMPRE `true`, e isso não é preguiça: para este canal a pergunta não tem
   * resposta síncrona honesta — a credencial pode viver na SESSÃO (banco), e
   * `isConfigured` é síncrono. Olhar só o env responderia "não configurado"
   * para toda organização que conectou pela tela, e a mensagem ficaria parada
   * sem erro com o canal funcionando (a issue #674 mediu isso no canal
   * oficial; o contrato daqui é o mesmo). Quem decide é o `send`, que pode
   * consultar o banco — e LANÇA `openwa_nao_configurado` quando desiste.
   */
  isConfigured(): boolean {
    return true;
  },

  codes: {
    notConfigured: "openwa_nao_configurado",
    sendFailed: "openwa_error",
    unknownError: "openwa_unknown",
  },

  /**
   * Pergunta ao TRANSPORTE se a conexão está de pé — a rota pública `/health`.
   *
   * Três desfechos, como no irmão: resposta é verdade do momento
   * (`connected && session.ready` → WORKING; respondeu mas não está pronto → o
   * estado que ele declarou); 401/403 → credencial recusada (o serviço inteiro
   * está fechado, não a sessão); qualquer outro erro → NÃO sabemos
   * (`reachable: false`), nunca um estado inventado.
   */
  async checkHealth(
    input: ChannelTenantScope & { sessionRef: string },
  ): Promise<ChannelHealth> {
    // Saúde é leitura, não envio: a falha de resolução vira DETALHE nomeado
    // (o cron não pode morrer por uma sessão quebrada), mas o CÓDIGO vai junto
    // para a tela dizer exatamente o que falta — nunca um fallback mudo.
    let creds;
    try {
      creds = await resolveOpenwaCreds(createAdminClient(), {
        organizationId: input.organizationId,
        sessionRef: input.sessionRef,
      });
    } catch (err) {
      const codigo = (err instanceof Error ? err.message : "erro_desconhecido").split(":")[0];
      return { reachable: false, status: null, detail: codigo.slice(0, 200) };
    }
    if (!creds) return { reachable: false, status: null, detail: "sem_credencial_para_a_sessao" };

    try {
      const h = await new OpenwaClient(creds.baseUrl, creds.apiKey).health();
      if (h.connected === true && h.session?.ready === true) {
        return { reachable: true, status: "WORKING", detail: null };
      }
      return { reachable: true, status: h.session?.state ?? "NOT_READY", detail: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.startsWith("openwa_http_401") || msg.startsWith("openwa_http_403")) {
        return { reachable: false, status: null, detail: DETALHE_CREDENCIAL_RECUSADA };
      }
      // O detalhe é um CÓDIGO, nunca o texto cru da exceção: "fetch failed"
      // e amigos carregam pedaço de destino/infraestrutura, e este detalhe
      // vai para a tela. O que não é código nosso vira o genérico nomeado.
      const codigo = msg.match(/^(openwa_[a-z0-9_]+)/)?.[1];
      return { reachable: false, status: null, detail: codigo ?? "openwa_health_erro_de_rede" };
    }
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    if (envelope.media || envelope.kind === "contact") {
      throw new Error(`openwa_kind_nao_suportado: ${envelope.kind} (o v1 deste canal envia texto)`);
    }

    // Sessão da organização primeiro, env como fallback (`./credentials.ts`).
    // Sem as duas fontes é ERRO NOMEADO, nunca um null que finge sucesso.
    const creds = await resolveOpenwaCreds(createAdminClient(), {
      organizationId: envelope.organizationId,
      sessionRef: envelope.sessionRef,
    });
    if (!creds) {
      throw new Error("openwa_nao_configurado: sem credencial na sessão nem no ambiente");
    }

    await envelope.beforeSend?.();
    const externalId = await new OpenwaClient(creds.baseUrl, creds.apiKey).sendText(
      envelope.to,
      envelope.body ?? "",
    );
    return { externalId };
  },
};
