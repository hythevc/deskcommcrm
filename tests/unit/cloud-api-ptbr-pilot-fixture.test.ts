import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metaCloudAdapter } from "@/lib/channels/adapters/meta-cloud";
import { ingestMetaInbound } from "@/lib/channels/meta/ingest";
import { parseMetaWebhook, type InboundMessageEvent } from "@/lib/channels/meta/webhook";
import { limparCacheDoNumeroInterno } from "@/lib/escalacao/numero-interno-de-aviso";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { resolveBranding } from "@/lib/branding";

const fixture = JSON.parse(readFileSync("tests/fixtures/pilot/cloud-api-ptbr.json", "utf8"));
const state = vi.hoisted(() => ({
  contact: null as Record<string, unknown> | null,
  message: null as Record<string, unknown> | null,
  conversation: null as Record<string, unknown> | null,
  mark: null as Record<string, unknown> | null,
  lead: null as Record<string, unknown> | null,
  events: [] as Array<Record<string, unknown>>,
  queries: [] as Array<{ table: string; filters: Record<string, unknown> }>,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => database() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
// Do not run the local worker, LLM, or external event drains in a contract test.
vi.mock("@/lib/dev/kick-local-pipeline", () => ({
  acelerarPipelineDeEventos: vi.fn(async () => {}),
  kickLocalPipeline: vi.fn(async () => {}),
}));

/** Fake ONLY the PostgREST/RPC boundary. Parser, ingest, lead selection and send are real. */
function database(): SupabaseClient {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let inserted: Record<string, unknown> | null = null;
      let ordering: { column: string; ascending: boolean } | null = null;
      let rowLimit: number | null = null;
      const selectRows = (rows: Array<Record<string, unknown>>) => {
        let matched = rows.filter((row) =>
          Object.entries(filters).every(([column, value]) => row[column] === value),
        );
        if (ordering) {
          const { column, ascending } = ordering;
          matched = [...matched].sort(
            (a, b) => (Number(a[column]) - Number(b[column])) * (ascending ? 1 : -1),
          );
        }
        return rowLimit === null ? matched : matched.slice(0, rowLimit);
      };
      const result = (single: boolean) => {
        state.queries.push({ table, filters: { ...filters } });
        let data: unknown = null;
        let error: { code: string; message: string } | null = null;
        if (table === "messages" && inserted) {
          if (state.message?.external_id === inserted.external_id) {
            error = { code: "23505", message: "duplicate external_id" };
          } else {
            state.message = { ...inserted, id: "message-fixture" };
            data = { id: "message-fixture" };
          }
        } else if (table === "channel_sessions") {
          data = { id: "session-fixture", organization_id: fixture.organizationId, metadata: {} };
        } else if (table === "contacts") {
          data = single ? state.contact : state.contact ? [state.contact] : [];
        } else if (table === "crm_leads") {
          data = state.lead ? { id: "lead-fixture" } : null;
        } else if (table === "crm_pipelines") {
          const rows = selectRows(fixture.pipelines);
          data = single ? (rows[0] ?? null) : rows;
        } else if (table === "crm_stages") {
          const rows = selectRows(fixture.stages);
          data = single ? (rows[0] ?? null) : rows;
        } else if (
          !["config_aviso_de_caso", "campaign_recipients", "crm_lead_activities"].includes(table)
        ) {
          throw new Error(`Unexpected fixture table: ${table}`);
        }
        return { data, error };
      };
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        is: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        in: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        order: (column: string, options: { ascending: boolean }) => {
          ordering = { column, ascending: options.ascending };
          return chain;
        },
        limit: (count: number) => {
          rowLimit = count;
          return chain;
        },
        insert: (row: Record<string, unknown>) => {
          inserted = row;
          return chain;
        },
        maybeSingle: async () => result(true),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(result(false)).then(resolve),
      };
      return chain;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "fn_upsert_wa_contact") {
        state.contact = {
          id: "contact-fixture",
          organization_id: args.p_org,
          phone_number: args.p_phone,
          name: args.p_notify,
          is_blocked: false,
        };
        return { data: "contact-fixture", error: null };
      }
      if (name === "fn_upsert_wa_conversation") {
        state.conversation = {
          id: "conversation-fixture",
          organization_id: args.p_org,
          contact_id: args.p_contact,
          channel_session_id: args.p_session,
        };
        return { data: "conversation-fixture", error: null };
      }
      if (name === "fn_mark_conversation_message") {
        state.mark = args;
        return { data: null, error: null };
      }
      if (name === "fn_nascer_lead_da_conversa") {
        state.lead = args;
        return { data: "lead-fixture", error: null };
      }
      if (name === "emit_event") {
        state.events.push(args);
        return { data: null, error: null };
      }
      throw new Error(`Unexpected fixture RPC: ${name}`);
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  state.contact = state.message = state.lead = state.conversation = state.mark = null;
  state.events = [];
  state.queries = [];
  limparCacheDoNumeroInterno();
  vi.stubEnv("META_PHONE_NUMBER_ID", fixture.phoneNumberId);
  vi.stubEnv("META_SYSTEM_USER_TOKEN", "synthetic-fixture-token-not-a-secret");
  vi.stubEnv("META_GRAPH_VERSION", "v19.0");
  vi.stubEnv("META_GRAPH_BASE_URL", "https://graph-fixture.invalid");
  // Every HTTP call is intercepted, including unexpected ones.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected fixture HTTP call");
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  limparCacheDoNumeroInterno();
});

function responseFetch(response: { status: number; body: unknown }) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: async () => response.body,
  }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const envelope = () => ({
  organizationId: fixture.organizationId,
  sessionRef: fixture.phoneNumberId,
  to: "5511987654321",
  kind: "text" as const,
  body: fixture.reply,
});

describe("synthetic Cloud API response contracts", () => {
  for (const response of fixture.responses) {
    it(response.name, async () => {
      const fetch = responseFetch(response);
      if (response.error)
        await expect(metaCloudAdapter.send(envelope())).rejects.toThrow(response.error);
      else
        await expect(metaCloudAdapter.send(envelope())).resolves.toEqual({
          externalId: response.externalId,
        });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[0]).toBe(
        "https://graph-fixture.invalid/v19.0/fixture-phone/messages",
      );
    });
  }
});

describe("PT-BR contact -> pipeline -> manual reply contract", () => {
  it("preserves Portuguese text, creates the linked lead and translates the reply without live sends", async () => {
    expect(IDIOMA_PADRAO).toBe("pt-BR");
    expect(traduzir("Contatos", IDIOMA_PADRAO)).toBe("Contatos");
    expect(resolveBranding("CRM de teste", null).name).toBe("CRM de teste");
    const event = parseMetaWebhook(fixture.inbound).find(
      (e): e is InboundMessageEvent => e.kind === "inbound_message",
    );
    expect(event).toBeDefined();
    const outcome = await ingestMetaInbound(database(), event!, {
      organizationId: fixture.organizationId,
    });
    expect(outcome).toEqual({
      status: "ingested",
      messageId: "message-fixture",
      conversationId: "conversation-fixture",
    });
    expect(state.contact).toMatchObject({
      id: "contact-fixture",
      organization_id: fixture.organizationId,
      name: "Cliente de teste",
      phone_number: "+5511987654321",
    });
    expect(state.conversation).toEqual({
      id: "conversation-fixture",
      organization_id: fixture.organizationId,
      contact_id: "contact-fixture",
      channel_session_id: "session-fixture",
    });
    expect(state.mark).toMatchObject({
      p_conv: "conversation-fixture",
      p_direction: "inbound",
      p_preview: event!.text,
      p_at: event!.sentAt.toISOString(),
    });
    expect(state.message).toMatchObject({
      id: "message-fixture",
      organization_id: fixture.organizationId,
      conversation_id: "conversation-fixture",
      channel_session_id: "session-fixture",
      direction: "inbound",
      status: "delivered",
      external_id: event!.externalId,
      sent_at: event!.sentAt.toISOString(),
      contact_id: "contact-fixture",
      body: "Olá! Quero uma proposta, por favor.",
    });
    expect(state.lead).toMatchObject({
      p_org: fixture.organizationId,
      p_contact: "contact-fixture",
      p_pipeline: "pipeline-fixture",
      p_stage: "stage-fixture",
      p_title: "Cliente de teste",
      p_source: "whatsapp",
    });
    expect(state.events[0]).toMatchObject({
      p_organization_id: fixture.organizationId,
      p_entity_id: "lead-fixture",
      p_payload: {
        pipeline_id: "pipeline-fixture",
        stage_id: "stage-fixture",
        conversation_id: "conversation-fixture",
      },
    });
    expect(state.events[1]).toMatchObject({
      p_organization_id: fixture.organizationId,
      p_entity_id: "message-fixture",
      p_payload: {
        organization_id: fixture.organizationId,
        conversation_id: "conversation-fixture",
        contact_id: "contact-fixture",
        channel_session_id: "session-fixture",
        inbound_message_id: "message-fixture",
      },
    });
    expect(state.events.map((e) => e.p_event_type)).toEqual([
      "lead.created",
      "ai_agent.dispatch_requested",
    ]);
    for (const query of state.queries) {
      if (query.table !== "messages" && query.table !== "crm_lead_activities") {
        expect(query.filters.organization_id).toBe(fixture.organizationId);
      }
    }
    expect(
      await ingestMetaInbound(database(), event!, { organizationId: fixture.organizationId }),
    ).toEqual({ status: "duplicate" });
    expect(state.events).toHaveLength(2);
    const fetch = responseFetch(fixture.responses[0]);
    const to = metaCloudAdapter.resolveRecipient({
      isGroup: false,
      groupChatId: null,
      phoneNumber: String(state.contact!.phone_number),
      waIdentity: null,
    });
    const beforeSend = vi.fn(async () => {});
    expect(await metaCloudAdapter.send({ ...envelope(), to: to!, beforeSend })).toEqual({
      externalId: "wamid.fixture-reply",
    });
    expect(beforeSend).toHaveBeenCalledOnce();
    const [, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "5511987654321",
      type: "text",
      text: { body: fixture.reply },
    });
  });
});
