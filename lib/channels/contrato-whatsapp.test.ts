/**
 * O CONTRATO COMPARTILHADO dos providers WhatsApp atrás do seam.
 *
 * A mesma bateria roda contra os DOIS lados — o canal oficial (`meta_cloud`)
 * e o OpenWA self-hosted (`openwa`) — porque o seam só vale se a pergunta
 * "o canal faz X?" tiver a mesma resposta estrutural para qualquer provider:
 *
 *   1. enviar texto (com escopo de organização) e receber o id externo;
 *   2. parsear o webhook de entrada num evento neutro;
 *   3. reportar estado (saúde da conexão / status de entrega);
 *   4. entregar o texto de opt-out INTACTO para a regra do produto
 *      (`lib/opt-out/deteccao.ts` — STOP/parar bloqueiam; "parar" no meio da
 *      frase, não);
 *   5. falhar fechado com códigos nomeados.
 *
 * Os DOIS lados falam HTTP real com servidores FALSOS no loopback: o OpenWA
 * com o fake da Easy API, e a Cloud API com um fake que responde o PostgREST
 * (a sessão sem token gravado, caindo no env) e a Graph (o POST da mensagem).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import { getAdapter } from "./index";
import { capabilitiesOf, CHANNEL_PROVIDER_META, CHANNEL_PROVIDER_OPENWA, transportaMensagem } from "./capabilities";
import { fonteDeTemplates } from "./templates-fonte";
import { parseMetaWebhook } from "./meta/webhook";
import { parseOpenwaWebhook } from "./openwa/webhook";

const ORG = "org-contrato-whatsapp";
const CLIENTE = "5531988877776";

// ─── Os dois servidores falsos ─────────────────────────────────────────────

let server: Server;
let baseUrl: string;
const http: { method: string; url: string; authorization: string | null; apiKey: string | null; body: unknown }[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    await new Promise((r) => req.on("end", r));
    http.push({
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: req.headers.authorization ? String(req.headers.authorization) : null,
      apiKey: req.headers["x-api-key"] ? String(req.headers["x-api-key"]) : null,
      body: raw ? JSON.parse(raw) : null,
    });
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/rest/v1/rpc/fn_decrypt_oauth")) {
      res.end(JSON.stringify("chave-contrato"));
      return;
    }
    if (req.url?.startsWith("/rest/v1/")) {
      // Meta: a sessão NÃO tem token gravado → cai no env (transição histórica
      // do canal oficial). OpenWA: devolve a linha da ORGANIZAÇÃO — a falha
      // fechada deste canal proíbe o env socorrer escopo de organização.
      if (req.url.includes("openwa_session_name")) {
        res.end(
          JSON.stringify([
            { openwa_session_name: "sales", openwa_base_url: baseUrl, openwa_api_key_encrypted: "c0ffee" },
          ]),
        );
        return;
      }
      res.end("[]");
      return;
    }
    if (req.method === "POST" && /\/v[\d.]+\/[^/]+\/messages$/.test(req.url ?? "")) {
      res.end(JSON.stringify({ messages: [{ id: "wamid.CONTRATO1" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/messages/sendText") {
      res.end(JSON.stringify("true_5531988877776@c.us_CONTRATO1"));
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.end(JSON.stringify({ connected: true, session: { ready: true } }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// ─── 1. Registro e perfil declarado ────────────────────────────────────────

describe("registro no seam", () => {
  it("os dois providers têm adapter com códigos nomeados", () => {
    for (const p of [CHANNEL_PROVIDER_META, CHANNEL_PROVIDER_OPENWA] as const) {
      const a = getAdapter(p);
      expect(a.provider).toBe(p);
      expect(a.codes.notConfigured).toContain(p === "meta_cloud" ? "meta" : p);
      expect(a.codes.sendFailed.length).toBeGreaterThan(0);
      expect(transportaMensagem(p)).toBe(true);
    }
  });

  it("o perfil de restrição declara quem exige template — e a fonte de modelos concorda", () => {
    expect(capabilitiesOf(CHANNEL_PROVIDER_META).requiresTemplates).toBe(true);
    expect(fonteDeTemplates(CHANNEL_PROVIDER_META)).toBe("oficial");
    expect(capabilitiesOf(CHANNEL_PROVIDER_OPENWA).requiresTemplates).toBe(false);
    expect(fonteDeTemplates(CHANNEL_PROVIDER_OPENWA)).toBeNull();
    // Os dois são auto-declarados não-oficiais/oficiais no risco de banimento.
    expect(capabilitiesOf(CHANNEL_PROVIDER_META).banRisk).toBe(false);
    expect(capabilitiesOf(CHANNEL_PROVIDER_OPENWA).banRisk).toBe(true);
  });

  it("resolveRecipient endereça o mesmo cliente nos dois dialetos", () => {
    const input = { isGroup: false, groupChatId: null, phoneNumber: "+55 31 98887-7776", waIdentity: null };
    expect(getAdapter(CHANNEL_PROVIDER_META).resolveRecipient(input)).toBe("5531988877776");
    expect(getAdapter(CHANNEL_PROVIDER_OPENWA).resolveRecipient(input)).toBe("5531988877776@c.us");
    // Sem telefone, os dois respondem null — nunca um endereço inventado.
    expect(getAdapter(CHANNEL_PROVIDER_META).resolveRecipient({ ...input, phoneNumber: null })).toBeNull();
    expect(getAdapter(CHANNEL_PROVIDER_OPENWA).resolveRecipient({ ...input, phoneNumber: null })).toBeNull();
  });
});

// ─── 2. Envio de texto, com o escopo de organização atravessando ──────────

describe("envio de texto", () => {
  it("openwa: PostgREST filtra PELA ORGANIZAÇÃO, decifra a chave da sessão e o POST sai com ELA", async () => {
    // Mesmo padrão do teste da Meta abaixo: o client admin lê o env na
    // IMPORTAÇÃO (lib/env), então módulos novos para a URL falsa valer.
    process.env.NEXT_PUBLIC_SUPABASE_URL = baseUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-de-contrato";
    vi.resetModules();
    const { openwaAdapter } = await import("./openwa/adapter");

    const antes = http.length;
    const r = await openwaAdapter.send({
      organizationId: ORG,
      sessionRef: "sales",
      to: `${CLIENTE}@c.us`,
      kind: "text",
      body: "parar de me mandar mensagem",
    });

    expect(r.externalId).toBe("true_5531988877776@c.us_CONTRATO1");
    const novas = http.slice(antes);

    // A busca de credencial é escopada pela ORGANIZAÇÃO — o MESMO tenant-scope
    // do canal oficial (issue #236), não só "o envelope carrega o campo".
    const busca = novas.find((c) => c.url.startsWith("/rest/v1/channel_sessions"));
    expect(busca).toBeDefined();
    expect(busca!.url).toContain(`organization_id=eq.${ORG}`);

    // A chave é a DA SESSÃO (decifrada via RPC), nunca a do ambiente: com
    // escopo de organização este canal falha FECHADO, sem fallback de env.
    const chamada = novas.find((c) => c.url === "/api/messages/sendText");
    expect(chamada?.apiKey).toBe("chave-contrato");
    expect(chamada?.body).toEqual({ to: `${CLIENTE}@c.us`, content: "parar de me mandar mensagem" });
  });

  it("meta_cloud: PostgREST filtra PELA ORGANIZAÇÃO e a Graph recebe o corpo oficial", async () => {
    // O client admin lê o env na IMPORTAÇÃO (lib/env): módulos novos para a
    // URL falsa valer — sem isto o teste falaria com o placeholder `.invalid`.
    process.env.NEXT_PUBLIC_SUPABASE_URL = baseUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-de-contrato";
    process.env.META_PHONE_NUMBER_ID = "5551990001111";
    process.env.META_SYSTEM_USER_TOKEN = "token-de-contrato";
    process.env.META_GRAPH_BASE_URL = baseUrl;
    vi.resetModules();
    const { metaCloudAdapter } = await import("./adapters/meta-cloud");

    const antes = http.length;
    const r = await metaCloudAdapter.send({
      organizationId: ORG,
      sessionRef: "5551990001111",
      to: CLIENTE,
      kind: "text",
      body: "Olá!",
    });

    expect(r.externalId).toBe("wamid.CONTRATO1");
    const novas = http.slice(antes);

    // A busca de credencial é escopada pela ORGANIZAÇÃO — a prova do
    // tenant-scope do seam (issue #236): sem o filtro, a mensagem sairia
    // pela conta do `.env` de OUTRA organização.
    const busca = novas.find((c) => c.url.startsWith("/rest/v1/channel_sessions"));
    expect(busca).toBeDefined();
    expect(busca!.url).toContain(`organization_id=eq.${ORG}`);

    const envio = novas.find((c) => /\/messages$/.test(c.url));
    expect(envio).toBeDefined();
    expect(envio!.url).toContain("/5551990001111/messages");
    expect(envio!.authorization).toBe("Bearer token-de-contrato");
    expect(envio!.body).toMatchObject({
      messaging_product: "whatsapp",
      to: CLIENTE,
      type: "text",
      text: { body: "Olá!" },
    });
  });
});

// ─── 3. Webhook de entrada: o mesmo evento neutro dos dois lados ──────────

describe("parse do webhook de entrada", () => {
  it("meta_cloud: messages[] vira inbound_message com wamid e texto", () => {
    const eventos = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA-1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { display_phone_number: "15551990001", phone_number_id: "5551990001111" },
                contacts: [{ profile: { name: "Maria" }, wa_id: CLIENTE }],
                messages: [
                  { from: CLIENTE, id: "wamid.IN1", timestamp: "1700000000", type: "text", text: { body: "parar" } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(eventos).toHaveLength(1);
    const e = eventos[0];
    expect(e).toMatchObject({
      kind: "inbound_message",
      wabaId: "WABA-1",
      phoneNumberId: "5551990001111",
      externalId: "wamid.IN1",
      from: CLIENTE,
      text: "parar",
    });
  });

  it("openwa: message.received vira inbound_message com o id do serviço e texto", () => {
    const r = parseOpenwaWebhook(
      JSON.stringify({
        sessionId: "sales",
        event: "message.received",
        payload: {
          message: {
            id: `false_${CLIENTE}@c.us_ABC`,
            from: `${CLIENTE}@c.us`,
            to: "5531900001111@c.us",
            body: "parar",
            type: "chat",
            timestamp: 1700000000,
            fromMe: false,
            isGroupMsg: false,
          },
        },
        timestamp: 1700000000123,
      }),
    );
    expect(r.ok && r.event).toMatchObject({
      kind: "inbound_message",
      sessionId: "sales",
      externalId: `false_${CLIENTE}@c.us_ABC`,
      from: `${CLIENTE}@c.us`,
      text: "parar",
    });
  });
});

// ─── 4. STOP/opt-out: o texto atravessa intacto nos DOIS canais ───────────

describe("opt-out atravessa o parse intacto", () => {
  it("parar/STOP/sair bloqueiam nos dois parsers; 'parar a dor', não", () => {
    const metaInbound = (body: string) =>
      parseMetaWebhook({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "W",
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "P" },
                  messages: [{ from: CLIENTE, id: "wamid.X", type: "text", text: { body } }],
                },
              },
            ],
          },
        ],
      });
    const openwaInbound = (body: string) =>
      parseOpenwaWebhook(
        JSON.stringify({
          sessionId: "s",
          event: "message.received",
          payload: { message: { id: "false_x@c.us_1", from: `${CLIENTE}@c.us`, body, fromMe: false } },
        }),
      );

    for (const body of ["parar", "STOP", "sair"]) {
      const m = metaInbound(body)[0];
      expect(m.kind === "inbound_message" && ehPedidoDeOptOut(m.text ?? "")).toBe(true);
      const o = openwaInbound(body);
      expect(o.ok && o.event?.kind === "inbound_message" && ehPedidoDeOptOut(o.event.text ?? "")).toBe(true);
    }
    for (const body of ["tem como parar a dor?", "posso sair antes das 15h?"]) {
      const m = metaInbound(body)[0];
      expect(m.kind === "inbound_message" && ehPedidoDeOptOut(m.text ?? "")).toBe(false);
      const o = openwaInbound(body);
      expect(o.ok && o.event?.kind === "inbound_message" && ehPedidoDeOptOut(o.event.text ?? "")).toBe(false);
    }
  });
});

// ─── 5. Estado: entrega (meta) e conexão (openwa) ─────────────────────────

describe("estado", () => {
  it("meta_cloud: statuses[] vira message_status com o wamid da nossa mensagem", () => {
    const eventos = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "W",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "P" },
                statuses: [
                  { id: "wamid.OUT1", status: "delivered", timestamp: "1700000100", recipient_id: CLIENTE },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      kind: "message_status",
      externalId: "wamid.OUT1",
      status: "delivered",
      recipient: CLIENTE,
    });
  });

  it("openwa: /health pronto → WORKING; session.state.changed vira evento de estado", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = baseUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-de-contrato";
    vi.resetModules();
    const { openwaAdapter } = await import("./openwa/adapter");
    // Escopo de organização: a credencial vem da linha da sessão (o fake
    // PostgREST a devolve; a chave sai do RPC). Sem env nenhum envolvido.
    delete process.env.OPENWA_API_BASE_URL;
    delete process.env.OPENWA_API_KEY;
    const saude = await openwaAdapter.checkHealth!({
      organizationId: ORG,
      sessionRef: "sales",
    });
    expect(saude).toEqual({ reachable: true, status: "WORKING", detail: null });

    const r = parseOpenwaWebhook(
      JSON.stringify({ sessionId: "sales", event: "session.state.changed", payload: { state: "TIMEOUT" } }),
    );
    expect(r).toEqual({ ok: true, event: { kind: "session_state", sessionId: "sales", state: "TIMEOUT" } });
  });
});
