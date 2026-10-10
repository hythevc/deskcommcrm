/**
 * Teste de CONTRATO do adapter OpenWA contra servidores FALSOS de verdade.
 *
 * Nada de dublê de `fetch`: `node:http` sobe no loopback e o adapter fala
 * HTTP real — prova de que o cliente monta o caminho, o header `X-API-Key` e
 * o corpo que a documentação v5 publica (openwa.dev/docs/getting-started/
 * easy-api), e de que lê o retorno do jeito que o serviço devolve
 * (`MessageId | boolean | string`).
 *
 * O MESMO fake responde o PostgREST (`/rest/v1/*`) e o RPC `fn_decrypt_oauth`:
 * a resolução (`./credentials.ts`) é FALHA-FECHADA — com escopo de
 * organização, qualquer defeito LANÇA e nada cai no env; sem escopo nenhum, o
 * modo single-tenant explícito lê só o ambiente. Um SEGUNDO servidor falso é
 * o "serviço da organização", para a prova de destino (e a prova de que um
 * redirect 307 NÃO carrega a chave) não depender de string comparada.
 *
 * Nenhum serviço OpenWA é instalado ou esperado: o fake implementa só as
 * rotas sob contrato (`POST /api/messages/sendText`, `GET /health`).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter, OutboundEnvelope } from "../types";

interface Chamada {
  method: string;
  url: string;
  apiKey: string | null;
  authorization: string | null;
  body: unknown;
}

const ORG = "org-contrato-0001";

// ─── Servidor A: a instalação "do .env" — e o PostgREST ────────────────────
let server: Server;
let baseUrl: string;
const chamadas: Chamada[] = [];
let saude: { connected?: boolean; session?: { ready?: boolean; state?: string } } = {
  connected: true,
  session: { ready: true },
};

/** As linhas que o PostgREST falso tem em `channel_sessions`. */
let sessoesNaBase: Record<string, unknown>[] = [];
/** O que o RPC `fn_decrypt_oauth` falso devolve (null = decifra impossível). */
let chaveDecifrada: string | null = "chave-da-sessao";
/** Quando setado, o sendText do servidor A responde 307 para este destino. */
let redirecionarPara: string | null = null;

// ─── Servidor B: o serviço OpenWA DA ORGANIZAÇÃO ───────────────────────────
let serverOrg: Server;
let baseUrlOrg: string;
const chamadasOrg: Chamada[] = [];

function lerCorpo(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function registrar(lista: Chamada[], req: IncomingMessage, raw: string) {
  lista.push({
    method: req.method ?? "",
    url: req.url ?? "",
    apiKey: req.headers["x-api-key"] ? String(req.headers["x-api-key"]) : null,
    authorization: req.headers.authorization ? String(req.headers.authorization) : null,
    body: raw ? JSON.parse(raw) : null,
  });
}

function responderOpenwa(lista: Chamada[], req: IncomingMessage, res: ServerResponse, _raw: string) {
  res.setHeader("content-type", "application/json");
  if (req.method === "POST" && req.url === "/api/messages/sendText") {
    if (redirecionarPara && lista === chamadas) {
      // O ataque medido: o serviço manda seguir para OUTRO host. O Location
      // aponta para o servidor B — se a chave chegar lá, o teste grita.
      res.statusCode = 307;
      res.setHeader("location", `${redirecionarPara}/api/messages/sendText`);
      res.end("{}");
      return;
    }
    res.end(JSON.stringify("true_5511998887776@c.us_3EB0CONTRATO1"));
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.end(JSON.stringify(saude));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({}));
}

let adapter: ChannelAdapter;

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const raw = await lerCorpo(req);
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/rest/v1/rpc/fn_decrypt_oauth")) {
      registrar(chamadas, req, raw);
      res.end(JSON.stringify(chaveDecifrada));
      return;
    }
    if (req.url?.startsWith("/rest/v1/")) {
      registrar(chamadas, req, raw);
      // Recorte de arquivamento como o PostgREST de verdade: o filtro vem na
      // URL (`archived_at=is.null` / `archived_at=not.is.null`).
      let linhas = sessoesNaBase;
      const url = req.url ?? "";
      if (url.includes("archived_at=is.null")) linhas = linhas.filter((l) => !l.archived_at);
      if (url.includes("archived_at=not.is.null")) linhas = linhas.filter((l) => Boolean(l.archived_at));
      // E o 406 do `maybeSingle()` com mais de uma linha — o PGRST116 real:
      // sem ele, o teste de "duas ativas" não mediria nada.
      if (url.includes("openwa_session_name") && linhas.length > 1 && !url.includes("limit=")) {
        res.statusCode = 406;
        res.end(
          JSON.stringify({
            code: "PGRST116",
            message: "JSON object requested, multiple (or no) rows returned",
            details: `The result contains ${linhas.length} rows`,
          }),
        );
        return;
      }
      res.end(JSON.stringify(linhas));
      return;
    }
    registrar(chamadas, req, raw);
    responderOpenwa(chamadas, req, res, raw);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  serverOrg = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const raw = await lerCorpo(req);
    registrar(chamadasOrg, req, raw);
    responderOpenwa(chamadasOrg, req, res, raw);
  });
  await new Promise<void>((resolve) => serverOrg.listen(0, "127.0.0.1", resolve));
  baseUrlOrg = `http://127.0.0.1:${(serverOrg.address() as AddressInfo).port}`;

  // O client admin e o `lib/env` leem o env na IMPORTAÇÃO: módulos novos para
  // a URL falsa valer (mesmo padrão do `contrato-whatsapp.test.ts`).
  process.env.NEXT_PUBLIC_SUPABASE_URL = baseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-de-contrato";
  vi.resetModules();
  ({ openwaAdapter: adapter } = await import("./adapter"));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => serverOrg.close(resolve));
});

function envelope(over: Partial<OutboundEnvelope> = {}): OutboundEnvelope {
  return {
    organizationId: ORG,
    sessionRef: "sales",
    to: "5511998887776@c.us",
    kind: "text",
    body: "Olá, tudo bem?",
    ...over,
  };
}

/** Envelope do MODO SINGLE-TENANT explícito: sem organização nem sessão. */
function envelopeSingleTenant(over: Partial<OutboundEnvelope> = {}): OutboundEnvelope {
  return envelope({ organizationId: "", sessionRef: "", ...over });
}

function reporPadroes() {
  sessoesNaBase = [];
  chaveDecifrada = "chave-da-sessao";
  redirecionarPara = null;
  saude = { connected: true, session: { ready: true } };
  delete process.env.OPENWA_SINGLE_TENANT;
  delete process.env.OPENWA_SESSION_NAME;
  delete process.env.OPENWA_SINGLE_TENANT_ORG_ID;
}

/** Liga o MODO SINGLE-TENANT declarado completo: flag + dono + nome. */
function ligarSingleTenant(orgId = "org-single-tenant") {
  process.env.OPENWA_SINGLE_TENANT = "1";
  process.env.OPENWA_SINGLE_TENANT_ORG_ID = orgId;
  process.env.OPENWA_SESSION_NAME = "sales";
}

describe("falha fechada — escopo de organização NUNCA cai no env", () => {
  it("sessão inexistente (ou arquivada): LANÇA openwa_sessao_nao_encontrada, e o env ligado não socorre", async () => {
    reporPadroes();
    // O env ESTÁ configurado de propósito: se houvesse fallback, o envio sairia
    // pelo serviço da instalação — o defeito da #236 que este canal não repete.
    process.env.OPENWA_API_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = "chave-do-env";
    sessoesNaBase = [];

    const antes = chamadas.length;
    await expect(adapter.send(envelope())).rejects.toThrow("openwa_sessao_nao_encontrada");
    // NENHUMA chamada de transporte saiu — nem no A, nem no B.
    expect(chamadas.slice(antes).some((c) => c.url === "/api/messages/sendText")).toBe(false);
    expect(chamadasOrg.some((c) => c.url === "/api/messages/sendText")).toBe(false);
  });

  it("organizationId vazio com sessionRef presente: LANÇA openwa_sem_escopo_de_organizacao", async () => {
    reporPadroes();
    process.env.OPENWA_API_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = "chave-do-env";
    await expect(adapter.send(envelope({ organizationId: "" }))).rejects.toThrow(
      "openwa_sem_escopo_de_organizacao",
    );
    await expect(adapter.send(envelope({ sessionRef: "" }))).rejects.toThrow("openwa_sessao_sem_ref");
  });

  it("linha sem chave gravada: LANÇA openwa_sessao_sem_credencial", async () => {
    reporPadroes();
    process.env.OPENWA_API_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = "chave-do-env";
    sessoesNaBase = [{ openwa_session_name: "sales", openwa_base_url: baseUrlOrg, openwa_api_key_encrypted: null }];
    await expect(adapter.send(envelope())).rejects.toThrow("openwa_sessao_sem_credencial");
  });

  it("decifra impossível: LANÇA openwa_credencial_ilegivel — a chave do env NÃO entra em cena", async () => {
    reporPadroes();
    process.env.OPENWA_API_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = "chave-do-env";
    sessoesNaBase = [{ openwa_session_name: "sales", openwa_base_url: baseUrlOrg, openwa_api_key_encrypted: "c0ffee" }];
    chaveDecifrada = null; // o RPC devolve null: GUC ausente, chave trocada

    const antesB = chamadasOrg.length;
    await expect(adapter.send(envelope())).rejects.toThrow("openwa_credencial_ilegivel");
    expect(chamadasOrg.slice(antesB).some((c) => c.url === "/api/messages/sendText")).toBe(false);
  });

  it("base reprovada no portão de SSRF: LANÇA openwa_base_invalida", async () => {
    reporPadroes();
    process.env.OPENWA_API_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = "chave-do-env";
    sessoesNaBase = [{
      openwa_session_name: "sales",
      openwa_base_url: "http://169.254.169.254/latest/meta-data",
      openwa_api_key_encrypted: "c0ffee",
    }];
    await expect(adapter.send(envelope())).rejects.toThrow("openwa_base_invalida");
  });

  it("legado AMARRADO: flag + org dona + nome igual ao ref + SEM linha → env; qualquer elo fora, lança", async () => {
    reporPadroes();
    process.env.OPENWA_API_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = "chave-do-env";
    sessoesNaBase = [];

    // Os elos alinhados: a instalação declarou single-tenant, a ORG dona é a
    // do pedido, e o env aponta para a MESMA sessão pedida.
    ligarSingleTenant(ORG);
    const antes = chamadas.length;
    const r = await adapter.send(envelope());
    expect(r.externalId).toBe("true_5511998887776@c.us_3EB0CONTRATO1");
    const envio = chamadas.slice(antes).find((c) => c.url === "/api/messages/sendText");
    expect(envio?.apiKey).toBe("chave-do-env");

    // Elo org fora: OUTRA organização sem linha própria NÃO é servida pelo
    // env da org dona — duas orgs sem linha não caem no mesmo env.
    await expect(adapter.send(envelope({ organizationId: "org-vizinha" }))).rejects.toThrow(
      "openwa_sessao_nao_encontrada",
    );

    // Elo org fora 2: flag SEM dono declarado não declara nada.
    delete process.env.OPENWA_SINGLE_TENANT_ORG_ID;
    await expect(adapter.send(envelope())).rejects.toThrow("openwa_sessao_nao_encontrada");
    process.env.OPENWA_SINGLE_TENANT_ORG_ID = ORG;

    // Elo nome fora: nome de sessão do env DIFERENTE do pedido → o env é de
    // outra sessão, e o fallback morre.
    process.env.OPENWA_SESSION_NAME = "outra-sessao";
    await expect(adapter.send(envelope())).rejects.toThrow("openwa_sessao_nao_encontrada");

    // Elo flag fora: sem ela, o legado não existe.
    process.env.OPENWA_SESSION_NAME = "sales";
    delete process.env.OPENWA_SINGLE_TENANT;
    await expect(adapter.send(envelope())).rejects.toThrow("openwa_sessao_nao_encontrada");
  });

  it("linha ARQUIVADA não é linha ausente: LANÇA openwa_sessao_arquivada e o resgate NÃO cobre", async () => {
    reporPadroes();
    // O ataque medido: arquivar a sessão e pedir envio. Com o filtro de
    // arquivamento na consulta, a linha sumiria, viraria "não encontrada" e
    // o modo single-tenant declarado mandaria PELA CHAVE DO ENV.
    process.env.OPENWA_API_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = "chave-do-env";
    ligarSingleTenant(ORG);
    sessoesNaBase = [{
      openwa_session_name: "sales",
      openwa_base_url: baseUrlOrg,
      openwa_api_key_encrypted: "c0ffee",
      archived_at: "2026-10-01T00:00:00Z",
    }];

    const antesA = chamadas.length;
    const antesB = chamadasOrg.length;
    await expect(adapter.send(envelope())).rejects.toThrow("openwa_sessao_arquivada");
    expect(chamadas.slice(antesA).some((c) => c.url === "/api/messages/sendText")).toBe(false);
    expect(chamadasOrg.slice(antesB).some((c) => c.url === "/api/messages/sendText")).toBe(false);
  });

  it("legado NÃO resgata linha quebrada: decifra falha continua lançando mesmo com a flag", async () => {
    reporPadroes();
    process.env.OPENWA_API_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = "chave-do-env";
    ligarSingleTenant(ORG);
    sessoesNaBase = [{ openwa_session_name: "sales", openwa_base_url: baseUrlOrg, openwa_api_key_encrypted: "c0ffee" }];
    chaveDecifrada = null;

    const antesA = chamadas.length;
    const antesB = chamadasOrg.length;
    await expect(adapter.send(envelope())).rejects.toThrow("openwa_credencial_ilegivel");
    expect(chamadasOrg.slice(antesB).some((c) => c.url === "/api/messages/sendText")).toBe(false);
    // E o env também não foi usado NESTA chamada: a linha EXISTE, a falha é real.
    expect(
      chamadas.slice(antesA).filter((c) => c.url === "/api/messages/sendText" && c.apiKey === "chave-do-env"),
    ).toHaveLength(0);
  });

  it("consulta de credencial não propaga a MENSAGEM crua do PostgREST — só o código", async () => {
    reporPadroes();
    // Derruba o PostgREST falso apontando o Supabase para uma porta fechada:
    // a consulta falha e o erro tem de ser o CÓDIGO nomeado, sem vazar
    // detalhe de infraestrutura na mensagem.
    process.env.OPENWA_API_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = "chave-do-env";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
    vi.resetModules();
    const { openwaAdapter: adapterSemBanco } = await import("./adapter");
    try {
      await expect(adapterSemBanco.send(envelope())).rejects.toThrow(/^openwa_creds_lookup_failed: \S+$/);
    } finally {
      process.env.NEXT_PUBLIC_SUPABASE_URL = baseUrl;
      vi.resetModules();
      ({ openwaAdapter: adapter } = await import("./adapter"));
    }
  });

  it("saúde com a sessão quebrada NÃO morre: o código vira detalhe nomeado", async () => {
    reporPadroes();
    delete process.env.OPENWA_API_BASE_URL;
    delete process.env.OPENWA_API_KEY;
    sessoesNaBase = [];
    await expect(adapter.checkHealth!({ organizationId: ORG, sessionRef: "sales" })).resolves.toEqual({
      reachable: false,
      status: null,
      detail: "openwa_sessao_nao_encontrada",
    });
  });
});

describe("modo single-tenant explícito — sem escopo, e o env EXIGE a declaração", () => {
  it("sem a flag, o env NÃO é credencial — nem sem escopo: LANÇA openwa_nao_configurado", async () => {
    reporPadroes();
    // O env está COMPLETO de propósito: sem OPENWA_SINGLE_TENANT=1 ele é um
    // segredo esquecido, não uma credencial de envio.
    process.env.OPENWA_API_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = "chave-de-contrato";
    // A resposta honesta é assíncrona (issue #674): quem desiste é o send.
    expect(adapter.isConfigured()).toBe(true);
    await expect(adapter.send(envelopeSingleTenant())).rejects.toThrow("openwa_nao_configurado");
  });

  it("com a flag mas SEM env: LANÇA openwa_nao_configurado", async () => {
    reporPadroes();
    delete process.env.OPENWA_API_BASE_URL;
    delete process.env.OPENWA_API_KEY;
    ligarSingleTenant();
    await expect(adapter.send(envelopeSingleTenant())).rejects.toThrow("openwa_nao_configurado");
  });

  it("envia texto pelo env: rota namespaced, X-API-Key, corpo {to, content} — e NENHUMA ida ao PostgREST", async () => {
    reporPadroes();
    process.env.OPENWA_API_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = "chave-de-contrato";
    ligarSingleTenant();

    const antes = chamadas.length;
    const r = await adapter.send(envelopeSingleTenant());

    expect(r.externalId).toBe("true_5511998887776@c.us_3EB0CONTRATO1");
    const envio = chamadas.slice(antes).find((c) => c.method === "POST" && c.url === "/api/messages/sendText");
    expect(envio).toBeDefined();
    expect(envio!.apiKey).toBe("chave-de-contrato");
    expect(envio!.body).toEqual({ to: "5511998887776@c.us", content: "Olá, tudo bem?" });
    // Sem escopo, nenhuma consulta de sessão acontece — o env é a ÚNICA fonte.
    expect(chamadas.slice(antes).some((c) => c.url.startsWith("/rest/v1/"))).toBe(false);
    expect(chamadasOrg).toHaveLength(0);
  });
});

describe("ordem de resolução — a ATIVA primeiro, arquivada nunca é 'ausente'", () => {
  it("ARQUIVADA + substituta ATIVA com o MESMO ref: envia pela ATIVA (a reconexão normal)", async () => {
    reporPadroes();
    process.env.OPENWA_API_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = "chave-do-env";
    // O defeito do v4: as DUAS linhas no maybeSingle sem filtro davam PGRST116
    // e a sessão nova, válida, não enviava NADA.
    sessoesNaBase = [
      {
        openwa_session_name: "sales",
        openwa_base_url: "https://antigo.invalid",
        openwa_api_key_encrypted: "dead",
        archived_at: "2026-09-01T00:00:00Z",
      },
      { openwa_session_name: "sales", openwa_base_url: baseUrlOrg, openwa_api_key_encrypted: "c0ffee" },
    ];

    const antesB = chamadasOrg.length;
    const r = await adapter.send(envelope());
    expect(r.externalId).toBe("true_5511998887776@c.us_3EB0CONTRATO1");
    const envioB = chamadasOrg.slice(antesB).find((c) => c.url === "/api/messages/sendText");
    expect(envioB).toBeDefined();
    expect(envioB!.apiKey).toBe("chave-da-sessao");
  });

  it("DUAS ATIVAS com o mesmo ref: ambiguidade de credencial é FALHA FECHADA, nunca 'pega a primeira'", async () => {
    reporPadroes();
    process.env.OPENWA_API_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = "chave-do-env";
    sessoesNaBase = [
      { openwa_session_name: "sales", openwa_base_url: baseUrlOrg, openwa_api_key_encrypted: "c0ffee" },
      { openwa_session_name: "sales", openwa_base_url: baseUrl, openwa_api_key_encrypted: "beef" },
    ];

    const antesA = chamadas.length;
    const antesB = chamadasOrg.length;
    await expect(adapter.send(envelope())).rejects.toThrow("openwa_creds_lookup_failed");
    expect(chamadas.slice(antesA).some((c) => c.url === "/api/messages/sendText")).toBe(false);
    expect(chamadasOrg.slice(antesB).some((c) => c.url === "/api/messages/sendText")).toBe(false);
  });
});

describe("escopo de organização — a credencial da SESSÃO, com prova de destino", () => {
  it("outra base, outra chave, filtro da organização — e NADA no serviço do env", async () => {
    reporPadroes();
    process.env.OPENWA_API_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = "chave-do-env";
    sessoesNaBase = [{
      openwa_session_name: "sales",
      openwa_base_url: baseUrlOrg,
      openwa_api_key_encrypted: "c0ffee", // hex sem prefixo — o decrypt normaliza
    }];

    const antesA = chamadas.length;
    const antesB = chamadasOrg.length;
    const r = await adapter.send(envelope());

    expect(r.externalId).toBe("true_5511998887776@c.us_3EB0CONTRATO1");
    const envioB = chamadasOrg.slice(antesB).find((c) => c.url === "/api/messages/sendText");
    expect(envioB).toBeDefined();
    expect(envioB!.apiKey).toBe("chave-da-sessao");
    expect(chamadas.slice(antesA).some((c) => c.url === "/api/messages/sendText")).toBe(false);

    // A busca filtra PELA ORGANIZAÇÃO — a prova do tenant-scope (issue #236).
    const busca = chamadas.slice(antesA).find((c) => c.url.startsWith("/rest/v1/channel_sessions"));
    expect(busca).toBeDefined();
    expect(busca!.url).toContain(`organization_id=eq.${ORG}`);
  });
});

describe("transporte — o que o fio nunca deixa escapar", () => {
  it("redirect 307 é RECUSADO: a chave e o corpo não seguem para o outro host", async () => {
    reporPadroes();
    process.env.OPENWA_API_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = "chave-de-contrato";
    ligarSingleTenant();
    redirecionarPara = baseUrlOrg; // A responde 307 apontando para B

    const antesB = chamadasOrg.length;
    await expect(adapter.send(envelopeSingleTenant())).rejects.toThrow("openwa_redirect_recusado");
    // A prova do vazamento que NÃO aconteceu: B não viu sendText nenhum —
    // nem a chave, nem o corpo "Olá, tudo bem?".
    expect(chamadasOrg.slice(antesB)).toHaveLength(0);
  });

  it("roda o beforeSend do envelope ANTES do transporte", async () => {
    reporPadroes();
    process.env.OPENWA_API_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = "chave-de-contrato";
    ligarSingleTenant();
    const ordem: string[] = [];
    await adapter.send(envelopeSingleTenant({ beforeSend: async () => void ordem.push("beforeSend") }));
    ordem.push("depois");
    expect(ordem).toEqual(["beforeSend", "depois"]);
  });

  it("mídia e contato LANÇAM com o código nomeado — nunca envio pela metade", async () => {
    reporPadroes();
    process.env.OPENWA_API_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = "chave-de-contrato";
    ligarSingleTenant();
    await expect(
      adapter.send(envelopeSingleTenant({ kind: "image", media: { url: "https://x.invalid/a.png" } as never })),
    ).rejects.toThrow("openwa_kind_nao_suportado");
  });

  it("saúde: serviço pronto responde WORKING; pronto-parcial declara o estado", async () => {
    reporPadroes();
    process.env.OPENWA_API_BASE_URL = baseUrl;
    process.env.OPENWA_API_KEY = "chave-de-contrato";
    ligarSingleTenant();

    saude = { connected: true, session: { ready: true } };
    await expect(adapter.checkHealth!({ organizationId: "", sessionRef: "" })).resolves.toEqual({
      reachable: true,
      status: "WORKING",
      detail: null,
    });

    saude = { connected: false, session: { ready: false, state: "OPENING" } };
    const parcial = await adapter.checkHealth!({ organizationId: "", sessionRef: "" });
    expect(parcial.reachable).toBe(true);
    expect(parcial.status).toBe("OPENING");
  });

  it("transporte fora do ar: reachable false, e o detalhe é CÓDIGO — nunca o texto cru da exceção", async () => {
    reporPadroes();
    process.env.OPENWA_API_BASE_URL = "http://127.0.0.1:1"; // porta fechada
    process.env.OPENWA_API_KEY = "chave-de-contrato";
    ligarSingleTenant();
    const r = await adapter.checkHealth!({ organizationId: "", sessionRef: "" });
    expect(r.reachable).toBe(false);
    expect(r.status).toBeNull();
    // "fetch failed" e amigos carregam pedaço de destino/infraestrutura — o
    // detalhe que vai para a tela é um código nosso.
    expect(r.detail).toBe("openwa_rede_inacessivel");
    expect(r.detail).not.toContain("fetch");
    expect(r.detail).toMatch(/^[a-z0-9_]+$/);
  });

  it("falha de rede no SEND vira openwa_rede_inacessivel — o sentinela cru NÃO atravessa", async () => {
    reporPadroes();
    process.env.OPENWA_API_BASE_URL = "http://127.0.0.1:1"; // porta fechada
    process.env.OPENWA_API_KEY = "chave-de-contrato";
    ligarSingleTenant();
    // A sonda do checker: a exceção crua ("fetch failed", ECONNREFUSED e o
    // endereço) sobrevivia na mensagem. Agora é código, e só código.
    await expect(adapter.send(envelopeSingleTenant())).rejects.toThrow(/^openwa_rede_inacessivel$/);
  });

  it("base de env inválida (sem esquema http) vira 'não configurado', nunca chamada", async () => {
    reporPadroes();
    process.env.OPENWA_API_BASE_URL = "ftp://nao-e-web";
    process.env.OPENWA_API_KEY = "chave-de-contrato";
    ligarSingleTenant();
    await expect(adapter.send(envelopeSingleTenant())).rejects.toThrow("openwa_nao_configurado");
  });
});
