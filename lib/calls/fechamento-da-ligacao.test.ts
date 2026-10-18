import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { fecharLigacaoSip } from "@/lib/calls/fechamento-da-ligacao";

type Escrita = { tabela: string; patch: Record<string, unknown>; filtros: [string, unknown][] };
type Rpc = { nome: string; args: Record<string, unknown> };

// O banco visto de fora: o que foi escrito, com quais filtros, e quais RPCs saíram.
function bancoFalso(opcoes: { falhaNaEscrita?: boolean } = {}) {
  const escritas: Escrita[] = [];
  const rpcs: Rpc[] = [];
  const cliente = {
    from(tabela: string) {
      return {
        update(patch: Record<string, unknown>) {
          const escrita: Escrita = { tabela, patch, filtros: [] };
          escritas.push(escrita);
          const construtor = {
            eq(coluna: string, valor: unknown) {
              escrita.filtros.push([coluna, valor]);
              return construtor;
            },
            then<R>(resolver: (v: { data: null; error: { message: string } | null }) => R) {
              return Promise.resolve(
                resolver({
                  data: null,
                  error: opcoes.falhaNaEscrita ? { message: "falhou" } : null,
                }),
              );
            },
          };
          return construtor;
        },
      };
    },
    rpc(nome: string, args: Record<string, unknown>) {
      rpcs.push({ nome, args });
      return Promise.resolve({ data: "evento", error: null });
    },
  };
  return { cliente: cliente as unknown as SupabaseClient, escritas, rpcs };
}

const ORG = "0b5e2c1a-7d34-4f8e-9a62-1c3d5e7f9a0b";
const LIGACAO = "5f1e3d2c-8b7a-4c69-9d58-7e6f5a4b3c2d";
const FALA = "Quero a proposta revisada até amanhã.";

function entrada(transcript: { speaker: string; text: string; ts: string }[]) {
  return {
    organizationId: ORG,
    voiceCallId: LIGACAO,
    answeredAt: "2026-10-01T14:00:00.000Z",
    endedAt: new Date("2026-10-01T14:02:46.000Z"),
    transcript,
  };
}

describe("fim da ligação SIP", () => {
  it("encerra a linha da ligação filtrando pela organização", async () => {
    const banco = bancoFalso();
    await fecharLigacaoSip(
      banco.cliente,
      entrada([{ speaker: "customer", text: FALA, ts: "2026-10-01T14:00:10.000Z" }]),
    );
    expect(banco.escritas).toHaveLength(1);
    const [escrita] = banco.escritas;
    expect(escrita?.tabela).toBe("voice_calls");
    expect(escrita?.filtros).toEqual(
      expect.arrayContaining([
        ["id", LIGACAO],
        ["organization_id", ORG],
      ]),
    );
    expect(escrita?.patch).toMatchObject({ status: "ended", duration_ms: 166_000 });
  });

  it("com fala na transcrição, pede o resumo levando só o id da ligação", async () => {
    const banco = bancoFalso();
    const resultado = await fecharLigacaoSip(
      banco.cliente,
      entrada([{ speaker: "customer", text: FALA, ts: "2026-10-01T14:00:10.000Z" }]),
    );
    expect(resultado).toEqual({ resumoPedido: true });
    expect(banco.rpcs).toHaveLength(1);
    expect(banco.rpcs[0]).toEqual({
      nome: "emit_event",
      args: {
        p_event_type: "voice_call.summary_requested",
        p_entity_kind: "voice_call",
        p_entity_id: LIGACAO,
        p_payload: { voice_call_id: LIGACAO },
        p_organization_id: ORG,
      },
    });
    expect(JSON.stringify(banco.rpcs)).not.toContain(FALA);
  });

  it("sem fala nenhuma, não pede resumo", async () => {
    const banco = bancoFalso();
    const resultado = await fecharLigacaoSip(
      banco.cliente,
      entrada([{ speaker: "agent", text: "  ", ts: "2026-10-01T14:00:10.000Z" }]),
    );
    expect(resultado).toEqual({ resumoPedido: false });
    expect(banco.rpcs).toEqual([]);
  });

  it("se a ligação não foi marcada como encerrada, não pede resumo", async () => {
    const banco = bancoFalso({ falhaNaEscrita: true });
    const resultado = await fecharLigacaoSip(
      banco.cliente,
      entrada([{ speaker: "customer", text: FALA, ts: "2026-10-01T14:00:10.000Z" }]),
    );
    expect(resultado).toEqual({ resumoPedido: false });
    expect(banco.rpcs).toEqual([]);
  });
});
