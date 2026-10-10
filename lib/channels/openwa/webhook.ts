/**
 * Webhook do OpenWA — verificação e parse. **Puro e síncrono**, como o parser
 * do canal oficial (`meta/webhook.ts`): nada aqui toca banco nem rede, para
 * cada regra ser testável sem ambiente.
 *
 * ─── O contrato do fio (lido na documentação pública, 10/10/2026) ─────────
 *
 * A entrega v5 é do plugin `@open-wa/integration-webhook`, configurado no
 * serviço — não neste app. O envelope é sempre o mesmo
 * (openwa.dev/docs/client-and-integrations/webhook-payloads):
 *
 *   {
 *     "webhookId": "…",           // instância do plugin — NÃO é chave de
 *                                 // deduplicação (é o mesmo em todo evento)
 *     "sessionId": "sales",
 *     "event": "message.received",
 *     "payload": { "message": { "id": "false_123@c.us_ABC", "from": "123@c.us",
 *                  "to": "…", "body": "…", "type": "chat",
 *                  "timestamp": 1700000000, "fromMe": false, … } },
 *     "timestamp": 1700000000123
 *   }
 *
 * ─── A autenticação é um segredo ESTÁTICO, e isso é da doc ────────────────
 *
 * O plugin manda o segredo num header configurável (`headers:
 * {'X-Webhook-Secret': …}`) e o receptor canônico da própria doc compara com
 * `timingSafeEqual`. Não há HMAC para implementar nem para fingir que há: a
 * comparação aqui é a mesma do receptor de referência, sobre o MESMO nome de
 * header por padrão.
 */
import { timingSafeEqual } from "node:crypto";

/** O header que carrega o segredo — o nome do receptor canônico da documentação. */
export const OPENWA_WEBHOOK_SECRET_HEADER = "x-webhook-secret";

/** Curto demais para ser segredo — o mesmo piso da entrada genérica (`../inbound.ts`). */
const MIN_SECRET_LEN = 16;

/**
 * O POST é da nossa instalação do OpenWA? Comparação em tempo constante sobre
 * o segredo estático — o esquema que o plugin documenta.
 */
export function verifyOpenwaWebhookSecret(headers: Headers, secret: string | null): boolean {
  if (!secret || secret.length < MIN_SECRET_LEN) return false;
  const recebido = headers.get(OPENWA_WEBHOOK_SECRET_HEADER);
  if (!recebido) return false;
  // A comparação de comprimento é em BYTES, não em caracteres: `timingSafeEqual`
  // LANÇA com buffers de tamanhos diferentes, e duas strings com o mesmo
  // `.length` podem ter tamanhos de byte distintos ("é" são 2). Um lançamento
  // aqui é 500 no webhook — e um oráculo de timing disfarçado.
  const recebidoBuf = Buffer.from(recebido, "utf8");
  const secretBuf = Buffer.from(secret, "utf8");
  if (recebidoBuf.length !== secretBuf.length) return false;
  return timingSafeEqual(recebidoBuf, secretBuf);
}

/** Mensagem recebida do CONTATO — normalizada para a entrada do CRM. */
export interface OpenwaInboundMessage {
  kind: "inbound_message";
  sessionId: string;
  /** O id que o serviço deu à mensagem — a chave de idempotência. */
  externalId: string;
  from: string;
  /** `body`, ou `caption` quando a mídia é quem carrega o texto. */
  text: string | null;
  isGroup: boolean;
  sentAt: Date | null;
}

/** O eco do que a EMPRESA mandou (`fromMe: true`) — para reconhecer o próprio envio. */
export interface OpenwaEchoMessage {
  kind: "outbound_echo";
  sessionId: string;
  externalId: string;
  to: string;
  text: string | null;
}

/** A sessão do serviço mudou de estado (`session.state.changed`). */
export interface OpenwaSessionState {
  kind: "session_state";
  sessionId: string;
  state: string;
}

export type OpenwaWebhookEvent = OpenwaInboundMessage | OpenwaEchoMessage | OpenwaSessionState;

export type LeituraOpenwaWebhook =
  | { ok: true; event: OpenwaWebhookEvent | null }
  | {
      ok: false;
      /**
       * `contrato_violado` é distinto de `invalid_json` de propósito — o mesmo
       * motivo da entrada genérica: um diz que o corpo não é JSON, o outro que
       * o fio mudou. Os campos são NOMEADOS, nunca com valores (dado de cliente).
       */
      code: "invalid_json" | "contrato_violado";
      campos: string[];
    };

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * O corpo cru vira o evento neutro. `null` (com `ok: true`) = evento que não
 * interessa a este CRM (qualquer `event` fora dos três conhecidos).
 */
export function parseOpenwaWebhook(rawBody: string): LeituraOpenwaWebhook {
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return { ok: false, code: "invalid_json", campos: [] };
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { ok: false, code: "contrato_violado", campos: ["<raiz>"] };
  }
  const env = envelope as Record<string, unknown>;
  const sessionId = str(env.sessionId);
  const evento = str(env.event);
  if (!sessionId || !evento) {
    return { ok: false, code: "contrato_violado", campos: ["sessionId", "event"] };
  }

  if (evento === "session.state.changed") {
    const payload = (env.payload ?? {}) as Record<string, unknown>;
    return { ok: true, event: { kind: "session_state", sessionId, state: str(payload.state) ?? "UNKNOWN" } };
  }

  if (evento !== "message.received") {
    // Evento de outra família (presença, ack, reação…): arquiva, não ingere.
    return { ok: true, event: null };
  }

  const payload = env.payload as Record<string, unknown> | undefined;
  const message = payload?.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") {
    return { ok: false, code: "contrato_violado", campos: ["payload.message"] };
  }
  const id = str(message.id);
  const texto = str(message.body) ?? str(message.caption);
  const timestamp = typeof message.timestamp === "number" ? new Date(message.timestamp * 1000) : null;

  if (message.fromMe === true) {
    const to = str(message.to);
    if (!id || !to) return { ok: false, code: "contrato_violado", campos: ["payload.message.id", "payload.message.to"] };
    return { ok: true, event: { kind: "outbound_echo", sessionId, externalId: id, to, text: texto } };
  }

  const from = str(message.from);
  if (!id || !from) {
    return { ok: false, code: "contrato_violado", campos: ["payload.message.id", "payload.message.from"] };
  }
  return {
    ok: true,
    event: {
      kind: "inbound_message",
      sessionId,
      externalId: id,
      from,
      text: texto,
      isGroup: message.isGroupMsg === true || from.endsWith("@g.us"),
      sentAt: timestamp,
    },
  };
}
