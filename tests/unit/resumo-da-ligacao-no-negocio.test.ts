import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PONTO_POR_ID } from "@/lib/ai/pontos/registro";
import { getRegisteredHandlers } from "@/lib/event-log/dispatcher";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { ACTIVITY_LABEL_FALLBACK, activityLabel } from "@/lib/leads/activity-vocabulary";
import { agrupaTimeline } from "@/lib/leads/timeline-grouping";
import type { TimelineItemView } from "@/lib/types/contacts";

let n = 0;
function item(over: Partial<TimelineItemView> = {}): TimelineItemView {
  n += 1;
  return {
    id: `r${n}`,
    organization_id: "org",
    lead_id: "lead",
    contact_id: "contato",
    source_module: "ai",
    source_id: null,
    type: "ai_turn",
    payload: {},
    metadata: {},
    performed_at: "2026-10-01T14:03:00Z",
    performed_by_user_id: null,
    actor_kind: "ai",
    actor_agent_id: "agente-1",
    reason: null,
    evidence: null,
    ...over,
  };
}

describe("resumo da ligação na linha do tempo do negócio", () => {
  it("tem rótulo próprio, traduzido", () => {
    const rotulo = activityLabel("call_summarized");
    expect(rotulo).not.toBe(ACTIVITY_LABEL_FALLBACK);
    expect(DICIONARIO[rotulo]?.es).toBeTruthy();
  });

  it("não some num bloco do mesmo agente no mesmo minuto", () => {
    const resumo = item({ type: "call_summarized", source_module: "voice_calls" });
    const blocos = agrupaTimeline([
      item({ performed_at: "2026-10-01T14:03:20Z" }),
      { ...resumo, performed_at: "2026-10-01T14:03:10Z" },
      item({ performed_at: "2026-10-01T14:03:00Z" }),
    ]);
    expect(blocos).toContainEqual({
      tipo: "item",
      item: { ...resumo, performed_at: "2026-10-01T14:03:10Z" },
      aoVivo: false,
    });
  });

  it("não some no bloco do dia de uma linha do tempo longa", () => {
    const resumo = item({ type: "call_summarized", performed_at: "2026-10-01T09:00:00Z" });
    const longa = Array.from({ length: 30 }, (_, i) =>
      item({
        actor_kind: i % 2 === 0 ? "ai" : "user",
        actor_agent_id: i % 2 === 0 ? "agente-1" : null,
        performed_by_user_id: i % 2 === 0 ? null : "u1",
        performed_at: new Date(Date.parse("2026-10-01T12:00:00Z") - i * 5 * 60_000).toISOString(),
      }),
    );
    const blocos = agrupaTimeline([...longa, resumo]);
    expect(blocos.some((b) => b.tipo === "dia")).toBe(true);
    expect(blocos).toContainEqual({ tipo: "item", item: resumo, aoVivo: false });
  });
});

describe("pedido de resumo tem quem atenda", () => {
  it("um handler do event_log consome voice_call.summary_requested", () => {
    ensureHandlersRegistered();
    const consumidores = getRegisteredHandlers().filter((h) =>
      h.events.includes("voice_call.summary_requested"),
    );
    expect(consumidores).toHaveLength(1);
  });

  it("o ponto de IA do resumo grava em llm_calls e aponta para quem o chama", () => {
    const ponto = PONTO_POR_ID.get("resumo_de_ligacao");
    expect(ponto).toBeDefined();
    expect(ponto?.registraEm).toBe("llm_calls");
    expect(ponto?.fixo).toBeUndefined();
    expect(existsSync(ponto!.emissor)).toBe(true);
    expect(readFileSync(ponto!.emissor, "utf8")).toContain('purpose: "resumo_de_ligacao"');
  });
});
