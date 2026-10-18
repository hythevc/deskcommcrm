import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mock.admin }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
import { collectExportData } from "@/lib/lgpd/export-collector";

type Row = Record<string, unknown>;
const ORG = "tenant-a";
const OUTRA_ORG = "tenant-b";
const TITULAR = "contact-a";
const VIZINHO = "contact-b";
const pedido = {
  organizationId: ORG,
  requestId: "export-1",
  contactId: TITULAR,
  externalCustomerId: null,
};

let rows: Record<string, Row[]>;
let falhaNoResumo: { message: string } | null;

// Aplica filtro e projeção de verdade: coluna que o coletor não pede não chega.
class ReadQuery {
  columns = "";
  filters: [string, unknown][] = [];
  inFilters: [string, unknown[]][] = [];
  page: [number, number] = [0, 1000];
  constructor(readonly table: string) {}
  select(columns: string) {
    this.columns = columns;
    return this;
  }
  eq(key: string, value: unknown) {
    this.filters.push([key, value]);
    return this;
  }
  in(key: string, values: unknown[]) {
    this.inFilters.push([key, values]);
    return this;
  }
  order() {
    return this;
  }
  limit(limit: number) {
    this.page = [0, limit - 1];
    return this;
  }
  range(from: number, to: number) {
    this.page = [from, to];
    return this;
  }
  or() {
    return this;
  }
  async maybeSingle() {
    const result = await this.execute();
    return { ...result, data: result.data?.[0] ?? null };
  }
  then(resolve: (result: unknown) => unknown, reject?: (error: unknown) => unknown) {
    return this.execute().then(resolve, reject);
  }
  async execute() {
    const resumo = this.filters.some(
      ([key, value]) => key === "type" && value === "call_summarized",
    );
    if (resumo && falhaNoResumo) return { data: null, error: falhaNoResumo };
    const data = (rows[this.table] ?? [])
      .filter((row) => this.filters.every(([key, value]) => row[key] === value))
      .filter((row) => this.inFilters.every(([key, values]) => values.includes(row[key])))
      .slice(this.page[0], this.page[1] + 1)
      .map((row) =>
        Object.fromEntries(
          this.columns
            .split(",")
            .map((column) => column.trim())
            .map((column) => [column, row[column]]),
        ),
      );
    return { data, error: null };
  }
}

const turnos = [
  { speaker: "agent", text: "Bom dia, posso ajudar?", ts: "2026-10-01T13:00:00.000Z" },
  { speaker: "customer", text: "Quero fechar o plano anual.", ts: "2026-10-01T13:00:05.000Z" },
];

function chamada(id: string, organization_id: string, contact_id: string): Row {
  return {
    id,
    organization_id,
    contact_id,
    direction: "inbound",
    peer_phone: "+5500000000101",
    status: "ended",
    end_reason: "user_ended",
    started_at: "2026-10-01T13:00:00Z",
    answered_at: "2026-10-01T13:00:00Z",
    ended_at: "2026-10-01T13:00:42Z",
    duration_ms: 42000,
    transcript: turnos,
    metadata: { interno: "nao-exportar" },
  };
}

function resumo(
  id: string,
  source_id: string,
  organization_id: string,
  contact_id: string,
  payload: Row,
): Row {
  return {
    id,
    organization_id,
    contact_id,
    lead_id: "lead-a",
    type: "call_summarized",
    source_module: "voice_calls",
    source_id,
    performed_at: "2026-10-01T13:01:00Z",
    payload,
    evidence: { llm_call_ids: ["llm-1"] },
  };
}

const payloadDoResumo = {
  versao: 1,
  voice_call_id: "call-a",
  provider: "sip",
  duration_ms: 42000,
  turnos: 2,
  resumo: "O cliente quer fechar o plano anual.",
  pontos: ["Plano anual"],
  compromissos_do_cliente: ['"Quero fechar o plano anual." (cliente)'],
  proximo_passo_sugerido: "Enviar o contrato",
};

beforeEach(() => {
  falhaNoResumo = null;
  rows = {
    organizations: [
      { id: ORG, legal_name: "Empresa Teste", display_name: "Teste", dpo_email: null },
    ],
    contacts: [
      {
        id: TITULAR,
        organization_id: ORG,
        name: "Contato de teste",
        created_at: "2026-09-15T00:00:00Z",
      },
    ],
    voice_calls: [
      chamada("call-a", ORG, TITULAR),
      chamada("call-vizinho", ORG, VIZINHO),
      chamada("call-outra-org", OUTRA_ORG, TITULAR),
    ],
    crm_lead_activities: [
      resumo("act-a", "call-a", ORG, TITULAR, payloadDoResumo),
      // Resumo já redigido pela cascata: não há mais o que entregar.
      resumo("act-redigida", "call-a", ORG, TITULAR, {}),
      resumo("act-vizinho", "call-vizinho", ORG, VIZINHO, {
        ...payloadDoResumo,
        voice_call_id: "call-vizinho",
      }),
      resumo("act-outra-org", "call-outra-org", OUTRA_ORG, TITULAR, {
        ...payloadDoResumo,
        voice_call_id: "call-outra-org",
      }),
    ],
    messages: [
      {
        id: "msg-a",
        organization_id: ORG,
        contact_id: TITULAR,
        conversation_id: "conv-a",
        direction: "inbound",
        type: "audio",
        status: "delivered",
        body: null,
        media_url: "https://example.test/audio.ogg",
        media_derived_text: "Me liga depois das seis.",
        sent_at: "2026-10-01T12:00:00Z",
        created_at: "2026-10-01T12:00:00Z",
      },
    ],
  };
  mock.admin.mockReturnValue({ from: (table: string) => new ReadQuery(table) });
});

describe("LGPD: o pedido de acesso entrega o que foi dito na ligação e na nota de voz", () => {
  it("entrega a transcrição da ligação do titular, sem a de outro contato ou de outra organização", async () => {
    const payload = await collectExportData(pedido);
    expect(payload.voice_calls).toEqual([
      expect.objectContaining({ id: "call-a", transcript: turnos, duration_ms: 42000 }),
    ]);
    expect(payload.voice_calls[0]).not.toHaveProperty("metadata");
  });

  it("entrega junto da ligação o resumo que a IA escreveu sobre ela", async () => {
    const payload = await collectExportData(pedido);
    expect(payload.voice_calls[0]?.resumos_da_ia).toEqual([payloadDoResumo]);
  });

  it("a falha ao ler os resumos não derruba o export das ligações", async () => {
    falhaNoResumo = { message: "boom" };
    const payload = await collectExportData(pedido);
    expect(payload.voice_calls).toEqual([
      expect.objectContaining({ id: "call-a", transcript: turnos, resumos_da_ia: [] }),
    ]);
  });

  it("entrega a transcrição da nota de voz", async () => {
    const payload = await collectExportData(pedido);
    expect(payload.messages_recent).toEqual([
      expect.objectContaining({
        id: "msg-a",
        media_derived_text: "Me liga depois das seis.",
        has_media: true,
      }),
    ]);
  });
});
