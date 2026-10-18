/**
 * ANONIMIZAR APAGA O QUE FOI DITO NA LIGAÇÃO E NA NOTA DE VOZ — migration 0443.
 *
 * A 0348 pôs `voice_calls.transcript = null` na cascata; a 0379 redefiniu a
 * função a partir de um corpo sem essa linha, e `messages.media_derived_text`
 * (a transcrição da nota de voz) nunca esteve nela. A cascata devolvia SUCESSO
 * com as duas transcrições legíveis. Com o resumo da ligação na linha do tempo
 * (`call_summarized`), o mesmo texto ganha uma terceira cópia.
 *
 * Aqui a cascata REAL roda contra Postgres REAL, e o pedido de acesso também:
 * o que se apaga a pedido do titular é o que se entrega a pedido dele.
 *
 * O vizinho (mesma org) e a outra org existem para distinguir "apagou o certo"
 * de "apagou": um predicado largo demais ficaria verde em todo caso do titular.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ResumoDaLigacaoPayloadSchema } from "@/lib/calls/resumo-da-ligacao.schema";
import { collectExportData, type ExportPayload } from "@/lib/lgpd/export-collector";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 2,
});
afterAll(() => pool.end());

// Ponte de leitura do coletor para SQL real: projeção, filtro e paginação viram
// SQL de verdade — um `select *` aqui esconderia coluna que o coletor não pede.
const ident = (nome: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(nome)) throw Error(`identificador inválido: ${nome}`);
  return `"${nome}"`;
};
const campo = (expr: string): string => {
  const json = /^([a-z_]+)->>([a-z_]+)$/.exec(expr);
  return json ? `${ident(json[1]!)}->>'${json[2]}'` : ident(expr);
};
class LeituraReal {
  colunas = "";
  filtros: string[] = [];
  valores: unknown[] = [];
  ordem: string[] = [];
  tamanho?: number;
  deslocamento = 0;
  uma = false;
  soContagem = false;
  constructor(readonly tabela: string) {}
  private param(valor: unknown) {
    this.valores.push(valor);
    return `$${this.valores.length}`;
  }
  select(colunas: string, opcoes?: { head?: boolean }) {
    this.colunas = colunas;
    this.soContagem = !!opcoes?.head;
    return this;
  }
  eq(chave: string, valor: unknown) {
    this.filtros.push(`${campo(chave)}=${this.param(valor)}`);
    return this;
  }
  in(chave: string, valores: unknown[]) {
    this.filtros.push(`${campo(chave)}=any(${this.param(valores)})`);
    return this;
  }
  or(expr: string) {
    const termos = expr.split(",").map((termo) => {
      const [chave, op, valor] = termo.split(".");
      if (op !== "eq" || !chave || !valor) throw Error(`filtro não suportado: ${termo}`);
      return `${campo(chave)}=${this.param(valor)}`;
    });
    this.filtros.push(`(${termos.join(" or ")})`);
    return this;
  }
  order(chave: string, opcoes?: { ascending?: boolean; nullsFirst?: boolean }) {
    const sentido = opcoes?.ascending === false ? "desc" : "asc";
    this.ordem.push(
      `${campo(chave)} ${sentido}${opcoes?.nullsFirst === false ? " nulls last" : ""}`,
    );
    return this;
  }
  limit(tamanho: number) {
    this.tamanho = tamanho;
    return this;
  }
  range(de: number, ate: number) {
    this.deslocamento = de;
    this.tamanho = ate - de + 1;
    return this;
  }
  maybeSingle() {
    this.uma = true;
    return this.executar();
  }
  then(sim: (valor: unknown) => unknown, nao?: (erro: unknown) => unknown) {
    return this.executar().then(sim, nao);
  }
  async executar() {
    const onde = this.filtros.length ? ` where ${this.filtros.join(" and ")}` : "";
    if (this.soContagem) {
      const r = await pool.query(
        `select count(*)::int n from ${ident(this.tabela)}${onde}`,
        this.valores,
      );
      return { data: null, error: null, count: r.rows[0].n };
    }
    const projecao = this.colunas
      .split(",")
      .map((parte) => {
        const [apelido, origem] = parte.trim().split(":");
        return origem ? `${campo(origem)} as ${ident(apelido!)}` : campo(apelido!);
      })
      .join(",");
    const ordem = this.ordem.length ? ` order by ${this.ordem.join(",")}` : "";
    const teto = this.tamanho === undefined ? "" : ` limit ${this.tamanho}`;
    const consulta = `select ${projecao} from ${ident(this.tabela)}${onde}${ordem}${teto} offset ${this.deslocamento}`;
    const r = await pool.query(`with r as (${consulta}) select to_jsonb(r) j from r`, this.valores);
    const linhas = r.rows.map((l) => l.j);
    return { data: this.uma ? (linhas[0] ?? null) : linhas, error: null };
  }
}

const ORG = randomUUID();
const OUTRA_ORG = randomUUID();
const SESSAO = randomUUID();
const ALVO = randomUUID();
const VIZINHO = randomUUID();
const DE_FORA = randomUUID();
const PIPELINE = randomUUID();
const ETAPA = randomUUID();
const PIPELINE_FORA = randomUUID();
const ETAPA_FORA = randomUUID();

// Telefones com DDD 00: não existem, então não alcançam ninguém de verdade.
const TELEFONE_ALVO = "+5500000000101";
const TELEFONE_VIZINHO = "+5500000000102";
const TELEFONE_FORA = "+5500000000103";

function transcricao(quem: string) {
  return [
    {
      speaker: "agent",
      text: "Bom dia, aqui é a assistente da loja. Posso ajudar?",
      ts: "2026-10-01T13:00:00.000Z",
    },
    {
      speaker: "customer",
      text: `Oi, sou ${quem}, quero fechar a proposta do plano anual.`,
      ts: "2026-10-01T13:00:05.000Z",
    },
    {
      speaker: "agent",
      text: "Perfeito, envio o contrato ainda hoje.",
      ts: "2026-10-01T13:00:11.000Z",
    },
  ];
}

function resumoDaIa(chamadaId: string, quem: string) {
  return ResumoDaLigacaoPayloadSchema.parse({
    versao: 1,
    voice_call_id: chamadaId,
    provider: "sip",
    duration_ms: 42000,
    turnos: 3,
    resumo: `${quem} quer fechar o plano anual; a assistente vai enviar o contrato.`,
    pontos: ["Plano anual"],
    compromissos_do_cliente: [`"quero fechar a proposta" (${quem})`],
    proximo_passo_sugerido: "Enviar o contrato",
  });
}

type Semente = {
  contato: string;
  org: string;
  chamada: string;
  mensagem: string;
  atividade: string;
  quem: string;
};

async function semear(
  s: Omit<Semente, "chamada" | "mensagem" | "atividade">,
  telefone: string,
  pipeline: string,
  etapa: string,
  sessao: string,
): Promise<Semente> {
  const conversa = randomUUID();
  const negocio = randomUUID();
  const chamada = randomUUID();
  const mensagem = randomUUID();
  const atividade = randomUUID();
  await pool.query("insert into contacts(id, organization_id, display_name) values ($1, $2, $3)", [
    s.contato,
    s.org,
    s.quem,
  ]);
  await pool.query(
    "insert into conversations(id, organization_id, contact_id, channel_session_id, status) values ($1, $2, $3, $4, 'open')",
    [conversa, s.org, s.contato, sessao],
  );
  await pool.query(
    `insert into messages(id, organization_id, conversation_id, channel_session_id, contact_id, type, direction,
                          status, body, sent_via, sent_at, media_derived_text, media_derived_status)
     values ($1, $2, $3, $4, $5, 'audio', 'inbound', 'delivered', null, 'external_device', now(), $6, 'ready')`,
    [
      mensagem,
      s.org,
      conversa,
      sessao,
      s.contato,
      `Nota de voz: aqui é ${s.quem}, me liga depois das seis.`,
    ],
  );
  await pool.query(
    `insert into voice_calls(id, organization_id, contact_id, provider, direction, peer_phone, status, end_reason,
                             started_at, answered_at, ended_at, duration_ms, transcript)
     values ($1, $2, $3, 'sip', 'inbound', $4, 'ended', 'user_ended',
             now() - interval '5 minutes', now() - interval '5 minutes', now() - interval '4 minutes', 42000, $5)`,
    [chamada, s.org, s.contato, telefone, JSON.stringify(transcricao(s.quem))],
  );
  await pool.query(
    "insert into crm_leads(id, organization_id, pipeline_id, stage_id, title, contact_id) values ($1, $2, $3, $4, 'Plano anual', $5)",
    [negocio, s.org, pipeline, etapa, s.contato],
  );
  await pool.query(
    `insert into crm_lead_activities(id, organization_id, lead_id, contact_id, type, source_module, source_id,
                                     actor_kind, evidence, payload)
     values ($1, $2, $3, $4, 'call_summarized', 'voice_calls', $5, 'ai', $6, $7)`,
    [
      atividade,
      s.org,
      negocio,
      s.contato,
      chamada,
      JSON.stringify({ llm_call_ids: [randomUUID()] }),
      JSON.stringify(resumoDaIa(chamada, s.quem)),
    ],
  );
  return { ...s, chamada, mensagem, atividade };
}

async function linha<T extends pg.QueryResultRow>(consulta: string, params: unknown[]): Promise<T> {
  const { rows } = await pool.query<T>(consulta, params);
  if (!rows[0]) throw Error(`nenhuma linha: ${consulta}`);
  return rows[0];
}

const transcricaoDe = (id: string) =>
  linha<{ transcript: unknown; duration_ms: number; status: string }>(
    "select transcript, duration_ms, status from voice_calls where id = $1",
    [id],
  );
const textoDerivadoDe = (id: string) =>
  linha<{ media_derived_text: string | null }>(
    "select media_derived_text from messages where id = $1",
    [id],
  );
const payloadDe = (id: string) =>
  linha<{ payload: Record<string, unknown> }>(
    "select payload from crm_lead_activities where id = $1",
    [id],
  );

const exportar = (contato: string): Promise<ExportPayload> =>
  collectExportData({
    organizationId: ORG,
    requestId: randomUUID(),
    contactId: contato,
    externalCustomerId: null,
  });

let alvo: Semente;
let vizinho: Semente;
let deFora: Semente;
let exportAntes: ExportPayload;
let exportDepois: ExportPayload;

describe("anonimizar um contato apaga a transcrição da ligação e da nota de voz dele", () => {
  beforeAll(async () => {
    vi.mocked(createAdminClient).mockReturnValue({
      from: (tabela: string) => new LeituraReal(tabela),
    } as never);
    for (const org of [ORG, OUTRA_ORG])
      await pool.query(
        "insert into organizations(id, slug, legal_name, display_name) values ($1::uuid, $1::text, 'Empresa Teste', 'Teste')",
        [org],
      );
    const sessaoFora = randomUUID();
    for (const [sessao, org] of [
      [SESSAO, ORG],
      [sessaoFora, OUTRA_ORG],
    ] as const)
      await pool.query(
        "insert into channel_sessions(id, organization_id, waha_session_name, webhook_secret_encrypted) values ($1, $2, $3, '\\x00'::bytea)",
        [sessao, org, `sessao-${sessao}`],
      );
    for (const [pipeline, etapa, org] of [
      [PIPELINE, ETAPA, ORG],
      [PIPELINE_FORA, ETAPA_FORA, OUTRA_ORG],
    ] as const) {
      await pool.query(
        "insert into crm_pipelines(id, organization_id, name, slug) values ($1, $2, 'Vendas', 'vendas')",
        [pipeline, org],
      );
      await pool.query(
        "insert into crm_stages(id, organization_id, pipeline_id, name, slug, position) values ($1, $2, $3, 'Novo', 'novo', 1000)",
        [etapa, org, pipeline],
      );
    }
    alvo = await semear(
      { contato: ALVO, org: ORG, quem: "Pessoa Titular" },
      TELEFONE_ALVO,
      PIPELINE,
      ETAPA,
      SESSAO,
    );
    vizinho = await semear(
      { contato: VIZINHO, org: ORG, quem: "Pessoa Vizinha" },
      TELEFONE_VIZINHO,
      PIPELINE,
      ETAPA,
      SESSAO,
    );
    deFora = await semear(
      { contato: DE_FORA, org: OUTRA_ORG, quem: "Pessoa de Fora" },
      TELEFONE_FORA,
      PIPELINE_FORA,
      ETAPA_FORA,
      sessaoFora,
    );

    exportAntes = await exportar(ALVO);
    // A função REAL, que é o que o botão da ficha e o pedido formal chamam (0414).
    await pool.query("select public.fn_lgpd_cascade_redact_contact($1, $2, $3)", [
      ORG,
      ALVO,
      randomUUID(),
    ]);
    exportDepois = await exportar(ALVO);
  });

  it("o pedido de acesso entrega a transcrição da ligação do titular, e só a dele", () => {
    expect(exportAntes.voice_calls.map((c) => c.id)).toEqual([alvo.chamada]);
    expect(exportAntes.voice_calls[0]?.transcript).toEqual(transcricao("Pessoa Titular"));
  });

  it("o pedido de acesso entrega o resumo da ligação escrito pela IA", () => {
    expect(exportAntes.voice_calls[0]?.resumos_da_ia).toEqual([
      resumoDaIa(alvo.chamada, "Pessoa Titular"),
    ]);
  });

  it("o pedido de acesso entrega a transcrição da nota de voz do titular", () => {
    expect(exportAntes.messages_recent.map((m) => [m.id, m.media_derived_text])).toEqual([
      [alvo.mensagem, "Nota de voz: aqui é Pessoa Titular, me liga depois das seis."],
    ]);
  });

  it("a ligação do titular fica sem transcrição, e o registro da chamada fica de pé", async () => {
    const depois = await transcricaoDe(alvo.chamada);
    expect(depois.transcript).toBeNull();
    // Duração e status são operação (métrica do atendente, fatura), não dado da pessoa.
    expect(depois).toMatchObject({ duration_ms: 42000, status: "ended" });
  });

  it("a nota de voz do titular fica sem o texto transcrito", async () => {
    expect((await textoDerivadoDe(alvo.mensagem)).media_derived_text).toBeNull();
  });

  it("o resumo da ligação na linha do tempo do titular fica vazio", async () => {
    expect((await payloadDe(alvo.atividade)).payload).toEqual({});
  });

  it("o vizinho da mesma organização e a outra organização não são tocados", async () => {
    for (const s of [vizinho, deFora]) {
      expect((await transcricaoDe(s.chamada)).transcript).toEqual(transcricao(s.quem));
      expect((await textoDerivadoDe(s.mensagem)).media_derived_text).toContain(s.quem);
      expect((await payloadDe(s.atividade)).payload).toEqual(resumoDaIa(s.chamada, s.quem));
    }
  });

  it("depois da anonimização o pedido de acesso não devolve mais o que foi dito", () => {
    expect(exportDepois.voice_calls.map((c) => [c.id, c.transcript])).toEqual([
      [alvo.chamada, null],
    ]);
    expect(exportDepois.voice_calls[0]?.resumos_da_ia).toEqual([]);
    expect(exportDepois.messages_recent.map((m) => m.media_derived_text)).toEqual([null]);
  });
});

/** O bloco do apêndice como o `update.sh` o reaplica: do rótulo da 0443 ao próximo rótulo. */
function blocoDaMigration0443(): string {
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const inicio = baseline.search(/^-- ---- .*\(migration 0443\) ----$/m);
  if (inicio === -1) throw Error("o apêndice do baseline.sql não tem o bloco da migration 0443");
  const resto = baseline.slice(inicio + 1);
  const proximo = resto.search(/^-- ---- /m);
  return baseline.slice(inicio, proximo === -1 ? undefined : inicio + 1 + proximo);
}

describe("quem já foi anonimizado antes do conserto também perde as transcrições", () => {
  const JA_ANONIMO = randomUUID();
  const conversa = randomUUID();
  const ids = {
    chamadaAntes: randomUUID(),
    chamadaDepois: randomUUID(),
    notaAntes: randomUUID(),
    notaDepois: randomUUID(),
  };

  beforeAll(async () => {
    // Retrato de um banco que rodou a cascata sem este conserto: contato já
    // anonimizado e as transcrições de antes da anonimização ainda legíveis.
    await pool.query(
      `insert into contacts(id, organization_id, display_name, is_anonymized, anonymized_at)
       values ($1, $2, 'Cliente Anonimizado', true, now() - interval '1 day')`,
      [JA_ANONIMO, ORG],
    );
    await pool.query(
      "insert into conversations(id, organization_id, contact_id, channel_session_id, status) values ($1, $2, $3, $4, 'open')",
      [conversa, ORG, JA_ANONIMO, SESSAO],
    );
    for (const [id, quando] of [
      [ids.notaAntes, "2 days"],
      [ids.notaDepois, "0 days"],
    ] as const)
      await pool.query(
        `insert into messages(id, organization_id, conversation_id, channel_session_id, contact_id, type, direction,
                              status, sent_via, sent_at, created_at, media_derived_text, media_derived_status)
         values ($1, $2, $3, $4, $5, 'audio', 'inbound', 'delivered', 'external_device',
                 now() - $6::interval, now() - $6::interval, 'texto transcrito da nota', 'ready')`,
        [id, ORG, conversa, SESSAO, JA_ANONIMO, quando],
      );
    for (const [id, quando] of [
      [ids.chamadaAntes, "2 days"],
      [ids.chamadaDepois, "0 days"],
    ] as const)
      await pool.query(
        `insert into voice_calls(id, organization_id, contact_id, provider, direction, peer_phone, status,
                                 started_at, ended_at, duration_ms, transcript)
         values ($1, $2, $3, 'sip', 'inbound', 'Cliente Anonimizado', 'ended',
                 now() - $4::interval, now() - $4::interval, 1000, $5)`,
        [id, ORG, JA_ANONIMO, quando, JSON.stringify(transcricao("Pessoa Antiga"))],
      );

    // Duas vezes, como o update.sh: a cura tem de ser reaplicável.
    await pool.query(blocoDaMigration0443());
    await pool.query(blocoDaMigration0443());
  });

  it("a transcrição da ligação e a da nota de voz anteriores à anonimização são apagadas", async () => {
    expect((await transcricaoDe(ids.chamadaAntes)).transcript).toBeNull();
    expect((await textoDerivadoDe(ids.notaAntes)).media_derived_text).toBeNull();
  });

  it("o que nasceu depois da anonimização não é alcançado pela cura", async () => {
    expect((await transcricaoDe(ids.chamadaDepois)).transcript).toEqual(
      transcricao("Pessoa Antiga"),
    );
    expect((await textoDerivadoDe(ids.notaDepois)).media_derived_text).toBe(
      "texto transcrito da nota",
    );
  });

  it("contato que não foi anonimizado não é alcançado pela cura", async () => {
    expect((await transcricaoDe(vizinho.chamada)).transcript).toEqual(transcricao(vizinho.quem));
    expect((await textoDerivadoDe(vizinho.mensagem)).media_derived_text).toContain(vizinho.quem);
  });
});
