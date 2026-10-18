import type pg from "pg";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { llmEdgeConfigFromEnv, type LlmEdgeConfig } from "@/lib/agent-engine/edge/llm/credentials";
import type { ProviderRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { normalizarErro, runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import {
  RAZAO_DO_RESUMO,
  lerSaidaDoModelo,
  lerTranscricao,
  montarPayloadDoResumo,
  montarPromptDoResumo,
  motivoParaNaoResumir,
} from "@/lib/calls/resumo-da-ligacao";
import { env } from "@/lib/env";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { emitAgentActivityForContact } from "@/lib/leads/agent-activity";

export const RESUMO_DA_LIGACAO_CONSUMER_KEY = "resumo_da_ligacao_v1";

// Teto da resposta: o contrato cabe em ~1.700 caracteres; folga para o JSON.
const TETO_DE_TOKENS_DA_RESPOSTA = 1200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DependenciasDoResumo = {
  pool: () => pg.Pool;
  llmCfg: () => LlmEdgeConfig;
  registry?: ProviderRegistry;
};

type LigacaoLida = {
  id: string;
  provider: string;
  status: string;
  contact_id: string | null;
  ai_agent_id: string | null;
  duration_ms: number | null;
  transcript: unknown;
};

export async function resumirLigacao(
  row: EventRow,
  deps: DependenciasDoResumo,
): Promise<HandlerResult> {
  const consumer_key = RESUMO_DA_LIGACAO_CONSUMER_KEY;
  const voiceCallId = row.entity_id ?? row.payload.voice_call_id;
  if (typeof voiceCallId !== "string" || !UUID.test(voiceCallId)) {
    return { consumer_key, status: "skipped", detail: "sem_voice_call_id" };
  }

  let pool: pg.Pool;
  try {
    pool = deps.pool();
  } catch {
    return { consumer_key, status: "error", detail: "banco_indisponivel" };
  }

  // A organização vem da linha do event_log (gravada pelo emit_event), nunca do
  // payload: é ela que impede um evento de alcançar a ligação de outra empresa.
  const { rows } = await pool.query<LigacaoLida>(
    `select id, provider, status, contact_id, ai_agent_id, duration_ms, transcript
       from voice_calls
      where id = $1 and organization_id = $2`,
    [voiceCallId, row.organization_id],
  );
  const ligacao = rows[0];
  if (!ligacao) return { consumer_key, status: "skipped", detail: "ligacao_inexistente" };

  // O dreno reentrega em retry; sem esta leitura cada tentativa somaria uma
  // linha (crm_lead_activities não tem chave única por origem).
  const { rows: existentes } = await pool.query(
    `select 1 from crm_lead_activities
      where organization_id = $1 and type = 'call_summarized'
        and source_module = 'voice_calls' and source_id = $2
      limit 1`,
    [row.organization_id, voiceCallId],
  );
  const motivo = motivoParaNaoResumir(ligacao, { jaResumida: existentes.length > 0 });
  if (motivo !== null || ligacao.contact_id === null) {
    return { consumer_key, status: "skipped", detail: motivo ?? "sem_contato" };
  }

  const turnos = lerTranscricao(ligacao.transcript);
  const prompt = montarPromptDoResumo(turnos);

  let chamada: Awaited<ReturnType<typeof runModelCall>>;
  try {
    chamada = await runModelCall(
      pool,
      deps.llmCfg(),
      {
        tenantId: row.organization_id,
        leadId: ligacao.contact_id,
        agentId: ligacao.ai_agent_id,
        purpose: "resumo_de_ligacao",
        system: prompt.system,
        messages: prompt.messages,
        maxOutputTokens: TETO_DE_TOKENS_DA_RESPOSTA,
      },
      deps.registry ? { registry: deps.registry } : {},
    );
  } catch (err) {
    // Só o código normalizado: a mensagem do provedor pode ecoar a transcrição.
    return {
      consumer_key,
      status: "error",
      detail: `modelo_falhou:${normalizarErro(err).error_code}`,
    };
  }

  const saida = lerSaidaDoModelo(chamada.result.text ?? "");
  if (!saida.ok) return { consumer_key, status: "error", detail: saida.codigo };
  // Sem o id da chamada a linha cairia para 'system': melhor falhar e tentar de novo.
  if (!chamada.callId) return { consumer_key, status: "error", detail: "chamada_sem_registro" };

  const destino = await emitAgentActivityForContact({
    pool,
    organizationId: row.organization_id,
    contactId: ligacao.contact_id,
    type: "call_summarized",
    reason: RAZAO_DO_RESUMO,
    sourceModule: "voice_calls",
    sourceId: ligacao.id,
    evidence: { llm_call_ids: [chamada.callId] },
    agentId: ligacao.ai_agent_id,
    payload: montarPayloadDoResumo({ ligacao, turnos: turnos.length, saida: saida.saida }),
  });

  return {
    consumer_key,
    status: "ok",
    detail: destino.routed ? "resumo_gravado" : `nao_roteado:${destino.reason}`,
  };
}

export function criarHandlerDoResumoDaLigacao(deps: DependenciasDoResumo): EventHandler {
  return {
    key: RESUMO_DA_LIGACAO_CONSUMER_KEY,
    events: ["voice_call.summary_requested"],
    handle: (row) => resumirLigacao(row, deps),
  };
}

// Pool e config resolvidos na hora do evento, nunca no import: o registro de
// handlers é carregado por rotas que não têm SUPABASE_DB_URL.
export const resumoDaLigacaoHandler = criarHandlerDoResumoDaLigacao({
  pool: getRequestPool,
  llmCfg: () => llmEdgeConfigFromEnv(env),
});
