/**
 * Ligação transcrita vira UM resumo da IA no negócio certo — contra Postgres.
 *
 * O pedido nasce pelo `emit_event` de verdade (o mesmo RPC que o agente de voz
 * chama), o handler roda com um provedor roteirizado (nenhuma chamada paga) e o
 * teste lê o estado que sobrou: a linha do negócio, a linha de `llm_calls` que
 * a sustenta, e o que a outra organização enxerga.
 */
import { readFileSync } from "node:fs";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type * as Fechamento from "@/lib/calls/fechamento-da-ligacao";
import type * as Handler from "@/lib/calls/resumo-da-ligacao.handler";
import type * as Schema from "@/lib/calls/resumo-da-ligacao.schema";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type { LlmEdgeConfig } from "@/lib/agent-engine/edge/llm/credentials";
import type { EventHandler, EventRow } from "@/lib/event-log/dispatcher";
import { pgComoSupabase } from "../pg-como-supabase";

const PORTA = process.env.TEST_DB_PORT ?? "54329";
const pool = new pg.Pool({
  connectionString: `postgres://postgres:postgres@127.0.0.1:${PORTA}/postgres`,
  max: 3,
});

const ORG = "ca11ab1e-0000-4000-8000-000000000001";
const ORG_VIZINHA = "ca11ab1e-0000-4000-8000-000000000002";
const MEMBRO = "ca11ab1e-1111-4000-8000-000000000001";
const MEMBRO_VIZINHO = "ca11ab1e-1111-4000-8000-000000000002";
const AGENTE = "ca11ab1e-2222-4000-8000-000000000001";
const FUNIL = "ca11ab1e-3333-4000-8000-000000000001";
const ETAPA = "ca11ab1e-3333-4000-8000-000000000002";
const CONTATO = "ca11ab1e-4444-4000-8000-000000000001";
const CONTATO_AMBIGUO = "ca11ab1e-4444-4000-8000-000000000002";
const NEGOCIO = "ca11ab1e-5555-4000-8000-000000000001";
const NEGOCIO_AMBIGUO_1 = "ca11ab1e-5555-4000-8000-000000000002";
const NEGOCIO_AMBIGUO_2 = "ca11ab1e-5555-4000-8000-000000000003";
const LIGACAO = "ca11ab1e-6666-4000-8000-000000000001";
const LIGACAO_AMBIGUA = "ca11ab1e-6666-4000-8000-000000000002";
const LIGACAO_VAZIA = "ca11ab1e-6666-4000-8000-000000000003";
const LIGACAO_SAIDA_RUIM = "ca11ab1e-6666-4000-8000-000000000004";

const TRANSCRICAO = readFileSync("tests/fixtures/calls/ligacao-proposta.json", "utf8");
const TURNOS = (JSON.parse(TRANSCRICAO) as unknown[]).length;

const SAIDA_VALIDA = JSON.stringify({
  resumo:
    "Cliente avalia o plano para uma equipe de oito pessoas e pediu proposta revisada com pagamento anual, dentro do teto aprovado.",
  pontos: [
    "Equipe de oito pessoas usa planilha e WhatsApp individual",
    "Quer começar no início do mês que vem",
    "Proposta atual está acima do teto mensal",
  ],
  compromissos_do_cliente: [
    'O cliente disse: "eu levo para a diretoria na reunião de quinta-feira"',
    'O cliente disse: "eu já separo a planilha"',
  ],
  proximo_passo_sugerido:
    "Enviar a proposta revisada com plano anual e guia de importação até amanhã",
});

let respostaDoModelo = SAIDA_VALIDA;
let promptsRecebidos: string[] = [];

const USO = {
  inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 120, text: 120, reasoning: 0 },
};

let fechamento: typeof Fechamento;
let schema: typeof Schema;
let handler: EventHandler;

async function um<TLinha extends pg.QueryResultRow>(
  texto: string,
  params: unknown[] = [],
): Promise<TLinha | undefined> {
  const { rows } = await pool.query<TLinha>(texto, params);
  return rows[0];
}

/** Pede o resumo pelo RPC real e devolve a linha do event_log como o dreno a entrega. */
async function pedirResumo(organizationId: string, voiceCallId: string): Promise<EventRow> {
  const pedido = await fechamento.pedirResumoDaLigacao(pgComoSupabase(pool), {
    organizationId,
    voiceCallId,
  });
  expect(pedido.ok).toBe(true);
  const linha = await um<EventRow>(
    `select id, organization_id, event_type, entity_kind, entity_id, payload, metadata,
            consumed_by, attempts, created_at::text
       from event_log
      where organization_id = $1 and entity_id = $2 and event_type = 'voice_call.summary_requested'
      order by created_at desc limit 1`,
    [organizationId, voiceCallId],
  );
  if (!linha) throw new Error("o pedido de resumo não chegou ao event_log");
  return linha;
}

async function resumosDaLigacao(voiceCallId: string) {
  const { rows } = await pool.query<{
    id: string;
    organization_id: string;
    lead_id: string;
    actor_kind: string;
    actor_agent_id: string | null;
    reason: string | null;
    evidence: { llm_call_ids?: string[] } | null;
    payload: unknown;
  }>(
    `select id, organization_id, lead_id, actor_kind, actor_agent_id, reason, evidence, payload
       from crm_lead_activities
      where type = 'call_summarized' and source_module = 'voice_calls' and source_id = $1`,
    [voiceCallId],
  );
  return rows;
}

/** COUNT como usuário logado (papel `authenticated` + claims), dentro de transação desfeita. */
async function contarComo(usuario: string, texto: string, params: unknown[]): Promise<number> {
  const cliente = await pool.connect();
  try {
    await cliente.query("begin");
    await cliente.query("set local role authenticated");
    await cliente.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: usuario, role: "authenticated" }),
    ]);
    const { rows } = await cliente.query<{ n: string }>(texto, params);
    return Number(rows[0]?.n ?? "-1");
  } finally {
    await cliente.query("rollback");
    cliente.release();
  }
}

async function semearLigacao(id: string, contato: string, transcricao: string): Promise<void> {
  await pool.query(
    `insert into voice_calls
       (id, organization_id, provider, direction, status, end_reason, peer_phone, contact_id,
        ai_agent_id, handled_by, started_at, answered_at, ended_at, duration_ms, transcript)
     values ($1, $2, 'sip', 'inbound', 'ended', 'user_ended', '+5500000000001', $3, $4, 'ai',
             now() - interval '3 minutes', now() - interval '3 minutes', now(), 161000, $5::jsonb)`,
    [id, ORG, contato, AGENTE, transcricao],
  );
}

beforeAll(async () => {
  const providers: typeof Providers = await import("@/lib/agent-engine/edge/llm/providers");
  fechamento = await import("@/lib/calls/fechamento-da-ligacao");
  schema = await import("@/lib/calls/resumo-da-ligacao.schema");
  const modulo: typeof Handler = await import("@/lib/calls/resumo-da-ligacao.handler");

  const registry = providers.createFakeRegistry((async (opcoes: { prompt: unknown }) => {
    promptsRecebidos.push(JSON.stringify(opcoes.prompt));
    return {
      content: [{ type: "text" as const, text: respostaDoModelo }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  }) as never);

  handler = modulo.criarHandlerDoResumoDaLigacao({
    pool: () => pool,
    llmCfg: () => ({ anthropicApiKey: "chave-de-teste" }) as LlmEdgeConfig,
    registry,
  });

  await pool.query(
    `insert into auth.users (id, email) values
       ($1, 'resumo-membro@invariant.test'), ($2, 'resumo-vizinho@invariant.test')
     on conflict do nothing`,
    [MEMBRO, MEMBRO_VIZINHO],
  );
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings) values
       ($1, 'resumo-ligacao', 'Resumo Ligacao', 'Resumo Ligacao',
        '{"llm": {"provider": "anthropic", "default_model": "claude-haiku-4-5"}}'::jsonb),
       ($2, 'resumo-vizinha', 'Resumo Vizinha', 'Resumo Vizinha', '{}'::jsonb)`,
    [ORG, ORG_VIZINHA],
  );
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at) values
       ($1, $2, 'admin', now()), ($3, $4, 'admin', now())`,
    [MEMBRO, ORG, MEMBRO_VIZINHO, ORG_VIZINHA],
  );
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt)
     values ($1, $2, 'Agente de voz de teste', 'Atenda a ligação.')`,
    [AGENTE, ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, display_name) values
       ($1, $3, 'Contato da ligação'), ($2, $3, 'Contato com dois negócios')`,
    [CONTATO, CONTATO_AMBIGUO, ORG],
  );
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug) values ($1, $2, 'Vendas', 'vendas')`,
    [FUNIL, ORG],
  );
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position)
     values ($1, $2, $3, 'Proposta', 'proposta', 1000)`,
    [ETAPA, ORG, FUNIL],
  );
  await pool.query(
    `insert into crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, status, last_activity_at)
     values ($1, $5, $6, $7, $2, 'Plano da equipe', 'open', '2026-09-01T00:00:00Z'),
            ($3, $5, $6, $7, $8, 'Negócio A', 'open', '2026-09-01T00:00:00Z'),
            ($4, $5, $6, $7, $8, 'Negócio B', 'open', '2026-09-01T00:00:00Z')`,
    [NEGOCIO, CONTATO, NEGOCIO_AMBIGUO_1, NEGOCIO_AMBIGUO_2, ORG, FUNIL, ETAPA, CONTATO_AMBIGUO],
  );

  await semearLigacao(LIGACAO, CONTATO, TRANSCRICAO);
  await semearLigacao(LIGACAO_AMBIGUA, CONTATO_AMBIGUO, TRANSCRICAO);
  await semearLigacao(LIGACAO_VAZIA, CONTATO, "[]");
  await semearLigacao(LIGACAO_SAIDA_RUIM, CONTATO, TRANSCRICAO);
});

beforeEach(() => {
  respostaDoModelo = SAIDA_VALIDA;
  promptsRecebidos = [];
});

afterAll(async () => {
  await pool.end();
});

describe("ligação com transcrição vira um resumo no negócio", () => {
  it("o pedido no event_log leva só o id da ligação", async () => {
    const pedido = await pedirResumo(ORG, LIGACAO);
    expect(pedido.payload).toEqual({ voice_call_id: LIGACAO });
    expect(pedido.entity_kind).toBe("voice_call");
  });

  it("grava exatamente uma linha call_summarized, da IA, no negócio aberto do contato", async () => {
    const resultado = await handler.handle(await pedirResumo(ORG, LIGACAO));
    expect(resultado.status).toBe("ok");
    expect(promptsRecebidos).toHaveLength(1);
    expect(promptsRecebidos[0]).toContain("antes da campanha de fim de ano");

    const linhas = await resumosDaLigacao(LIGACAO);
    expect(linhas).toHaveLength(1);
    const [linha] = linhas;
    expect(linha?.organization_id).toBe(ORG);
    expect(linha?.lead_id).toBe(NEGOCIO);
    expect(linha?.actor_kind).toBe("ai");
    expect(linha?.actor_agent_id).toBe(AGENTE);
    expect(linha?.reason ?? "").not.toContain("diretoria");

    const payload = schema.ResumoDaLigacaoPayloadSchema.parse(linha?.payload);
    expect(payload).toMatchObject({
      versao: 1,
      voice_call_id: LIGACAO,
      provider: "sip",
      duration_ms: 161000,
      turnos: TURNOS,
    });

    const [idDaChamada] = linha?.evidence?.llm_call_ids ?? [];
    const chamada = await um<{
      purpose: string;
      organization_id: string;
      status: string;
      agent_id: string;
    }>(`select purpose, organization_id, status, agent_id from llm_calls where id = $1`, [
      idDaChamada,
    ]);
    expect(chamada).toEqual({
      purpose: "resumo_de_ligacao",
      organization_id: ORG,
      status: "ok",
      agent_id: AGENTE,
    });
  });

  it("rodar de novo (retry do dreno) não duplica nem chama o modelo", async () => {
    const resultado = await handler.handle(await pedirResumo(ORG, LIGACAO));
    expect(resultado.status).toBe("skipped");
    expect(promptsRecebidos).toHaveLength(0);
    expect(await resumosDaLigacao(LIGACAO)).toHaveLength(1);
  });

  it("a organização vizinha não enxerga o resumo; a dona enxerga", async () => {
    const consulta = `select count(*)::text as n from crm_lead_activities
                       where type = 'call_summarized' and source_id = $1`;
    expect(await contarComo(MEMBRO, consulta, [LIGACAO])).toBe(1);
    expect(await contarComo(MEMBRO_VIZINHO, consulta, [LIGACAO])).toBe(0);
  });

  it("evento em nome de outra organização não alcança a ligação desta", async () => {
    const forjado = await pedirResumo(ORG_VIZINHA, LIGACAO);
    const resultado = await handler.handle(forjado);
    expect(resultado.status).toBe("skipped");
    expect(promptsRecebidos).toHaveLength(0);
    const linhas = await resumosDaLigacao(LIGACAO);
    expect(linhas.map((l) => l.organization_id)).toEqual([ORG]);
  });
});

describe("quando o resumo não entra no negócio", () => {
  it("contato com dois negócios abertos: registra não-roteado e não grava linha", async () => {
    const resultado = await handler.handle(await pedirResumo(ORG, LIGACAO_AMBIGUA));
    expect(resultado.status).toBe("ok");
    expect(await resumosDaLigacao(LIGACAO_AMBIGUA)).toHaveLength(0);
    const naoRoteado = await um<{ payload: { reason: string; activity_type: string } }>(
      `select payload from event_log
        where organization_id = $1 and event_type = 'agent.activity_unrouted'
          and entity_id = $2 and metadata->>'source_id' = $3`,
      [ORG, CONTATO_AMBIGUO, LIGACAO_AMBIGUA],
    );
    expect(naoRoteado?.payload).toMatchObject({
      reason: "ambiguous_open_leads",
      activity_type: "call_summarized",
    });
  });

  it("transcrição vazia: não chama o modelo e não grava nada", async () => {
    const resultado = await handler.handle(await pedirResumo(ORG, LIGACAO_VAZIA));
    expect(resultado.status).toBe("skipped");
    expect(promptsRecebidos).toHaveLength(0);
    expect(await resumosDaLigacao(LIGACAO_VAZIA)).toHaveLength(0);
  });

  it("saída do modelo fora do contrato: evento falha com código sem dado do cliente, sem linha parcial", async () => {
    respostaDoModelo = "O cliente vai levar a proposta para a diretoria.";
    const resultado = await handler.handle(await pedirResumo(ORG, LIGACAO_SAIDA_RUIM));
    expect(resultado).toMatchObject({ status: "error", detail: "saida_invalida" });
    expect(await resumosDaLigacao(LIGACAO_SAIDA_RUIM)).toHaveLength(0);
  });
});
