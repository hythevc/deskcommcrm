/**
 * O parser PURO do webhook OpenWA: envelope v5 → evento neutro, e a costura
 * com a regra de opt-out do produto (`lib/opt-out/deteccao.ts`), que é quem
 * decide o bloqueio — o parser só precisa entregar o TEXTO intacto.
 *
 * Os corpos de exemplo seguem o envelope publicado em
 * openwa.dev/docs/client-and-integrations/webhook-payloads.
 */
import { describe, expect, it } from "vitest";

import { ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import {
  OPENWA_WEBHOOK_SECRET_HEADER,
  parseOpenwaWebhook,
  verifyOpenwaWebhookSecret,
} from "./webhook";

const SEGREDO = "segredo-de-contrato-com-32-chars!!";

function envelopeMessage(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    webhookId: "0f5d6a52-2ff2-43d5-9d0d-9c0c8dd5f9d1",
    sessionId: "sales",
    event: "message.received",
    payload: {
      message: {
        id: "false_5531988877776@c.us_ABC123",
        from: "5531988877776@c.us",
        to: "5531900001111@c.us",
        body: "parar",
        caption: "",
        type: "chat",
        timestamp: 1700000000,
        fromMe: false,
        isGroupMsg: false,
        isMedia: false,
        ...over,
      },
    },
    timestamp: 1700000000123,
  });
}

describe("webhook OpenWA — verificação do segredo", () => {
  it("aceita o segredo certo, recusa o errado, o curto e o ausente", () => {
    const certo = new Headers({ [OPENWA_WEBHOOK_SECRET_HEADER]: SEGREDO });
    expect(verifyOpenwaWebhookSecret(certo, SEGREDO)).toBe(true);
    expect(verifyOpenwaWebhookSecret(new Headers({ [OPENWA_WEBHOOK_SECRET_HEADER]: "x".repeat(SEGREDO.length) }), SEGREDO)).toBe(false);
    expect(verifyOpenwaWebhookSecret(certo, "curto")).toBe(false);
    expect(verifyOpenwaWebhookSecret(new Headers(), SEGREDO)).toBe(false);
    expect(verifyOpenwaWebhookSecret(certo, null)).toBe(false);
  });

  it("mesmo .length em caracteres, tamanho de BYTES diferente: false, nunca lança", () => {
    // "é" são 2 bytes em UTF-8: 16 acentuados (32 bytes) contra 16 ASCII
    // (16 bytes) têm o MESMO `.length`. Se a régua for o caractere, o
    // `timingSafeEqual` recebe buffers de tamanhos diferentes e LANÇA —
    // 500 no webhook e oráculo de timing. A régua é o byte.
    const segredoAcentuado = "é".repeat(16);
    const headerAscii = "a".repeat(16);
    expect(segredoAcentuado.length).toBe(headerAscii.length);
    const headers = new Headers({ [OPENWA_WEBHOOK_SECRET_HEADER]: headerAscii });
    expect(() => verifyOpenwaWebhookSecret(headers, segredoAcentuado)).not.toThrow();
    expect(verifyOpenwaWebhookSecret(headers, segredoAcentuado)).toBe(false);
    // E o par multibyte IDÊNTICO continua passando.
    const certo = new Headers({ [OPENWA_WEBHOOK_SECRET_HEADER]: segredoAcentuado });
    expect(verifyOpenwaWebhookSecret(certo, segredoAcentuado)).toBe(true);
  });

  it("segredo abaixo do piso (16) rejeita MESMO com header idêntico ao configurado", () => {
    // O piso MIN_SECRET_LEN vale para a CONFIGURAÇÃO, não para a comparação:
    // um segredo curto conhecido pelo emissor continua curto. Header e segredo
    // IGUAIS têm de falhar — senão o piso seria decorativo.
    const curto = "segredo-curto";
    expect(curto.length).toBeLessThan(16);
    const headers = new Headers({ [OPENWA_WEBHOOK_SECRET_HEADER]: curto });
    expect(verifyOpenwaWebhookSecret(headers, curto)).toBe(false);
  });
});

describe("webhook OpenWA — parse do envelope", () => {
  it("mensagem do contato vira inbound_message normalizada", () => {
    const r = parseOpenwaWebhook(envelopeMessage());
    expect(r).toEqual({
      ok: true,
      event: {
        kind: "inbound_message",
        sessionId: "sales",
        externalId: "false_5531988877776@c.us_ABC123",
        from: "5531988877776@c.us",
        text: "parar",
        isGroup: false,
        sentAt: new Date(1700000000 * 1000),
      },
    });
  });

  it("fromMe=true vira eco do próprio envio, endereçado ao cliente", () => {
    const r = parseOpenwaWebhook(envelopeMessage({ fromMe: true, from: "5531900001111@c.us", to: "5531988877776@c.us" }));
    expect(r.ok && r.event?.kind).toBe("outbound_echo");
    if (r.ok && r.event?.kind === "outbound_echo") {
      expect(r.event.to).toBe("5531988877776@c.us");
      expect(r.event.externalId).toContain("ABC123");
    }
  });

  it("session.state.changed vira evento de estado da sessão", () => {
    const r = parseOpenwaWebhook(
      JSON.stringify({ sessionId: "sales", event: "session.state.changed", payload: { state: "CONNECTED" }, timestamp: 1 }),
    );
    expect(r).toEqual({ ok: true, event: { kind: "session_state", sessionId: "sales", state: "CONNECTED" } });
  });

  it("evento fora do contrato conhecido é ignorado, não erro", () => {
    const r = parseOpenwaWebhook(JSON.stringify({ sessionId: "sales", event: "presence.changed", payload: {} }));
    expect(r).toEqual({ ok: true, event: null });
  });

  it("JSON quebrado é invalid_json; envelope sem sessionId/event é contrato_violado", () => {
    expect(parseOpenwaWebhook("não é json").ok).toBe(false);
    const r = parseOpenwaWebhook(JSON.stringify({ payload: {} }));
    expect(r).toEqual({ ok: false, code: "contrato_violado", campos: ["sessionId", "event"] });
  });

  it("mensagem sem id ou remetente é contrato_violado — nunca linha meia-boca", () => {
    const r = parseOpenwaWebhook(envelopeMessage({ id: "", from: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("contrato_violado");
  });
});

describe("webhook OpenWA — costura com o opt-out (STOP/parar)", () => {
  it("palavra isolada de descadastro atravessa intacta até a regra do produto", () => {
    for (const corpo of ["parar", "STOP", "sair", "PARAR!"]) {
      const r = parseOpenwaWebhook(envelopeMessage({ body: corpo }));
      expect(r.ok && r.event?.kind).toBe("inbound_message");
      if (r.ok && r.event?.kind === "inbound_message") {
        expect(r.event.text).toBe(corpo);
        expect(ehPedidoDeOptOut(r.event.text ?? "")).toBe(true);
      }
    }
  });

  it("'parar' no meio da frase NÃO é opt-out — a regra é da intenção, não da palavra", () => {
    const r = parseOpenwaWebhook(envelopeMessage({ body: "tem como parar a dor?" }));
    if (r.ok && r.event?.kind === "inbound_message") {
      expect(ehPedidoDeOptOut(r.event.text ?? "")).toBe(false);
    }
  });
});
