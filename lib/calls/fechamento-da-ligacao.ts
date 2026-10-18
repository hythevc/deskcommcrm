import type { SupabaseClient } from "@supabase/supabase-js";

import { lerTranscricao, type TurnoDaTranscricao } from "@/lib/calls/resumo-da-ligacao";

// Só o id: a transcrição é dado pessoal e mora só em voice_calls; uma cópia no
// event_log seria mais um lugar para a anonimização apagar.
export async function pedirResumoDaLigacao(
  admin: SupabaseClient,
  entrada: { organizationId: string; voiceCallId: string },
): Promise<{ ok: boolean }> {
  const { error } = await admin.rpc("emit_event", {
    p_event_type: "voice_call.summary_requested",
    p_entity_kind: "voice_call",
    p_entity_id: entrada.voiceCallId,
    p_payload: { voice_call_id: entrada.voiceCallId },
    p_organization_id: entrada.organizationId,
  });
  return { ok: !error };
}

export async function fecharLigacaoSip(
  admin: SupabaseClient,
  entrada: {
    organizationId: string;
    voiceCallId: string;
    answeredAt: string;
    endedAt: Date;
    transcript: TurnoDaTranscricao[];
  },
): Promise<{ resumoPedido: boolean }> {
  // duration_ms não é coluna gerada em voice_calls: sai do answered_at que o
  // próprio agente gravou.
  const durationMs = entrada.endedAt.getTime() - new Date(entrada.answeredAt).getTime();

  // Service role ignora RLS: o filtro por organização é a única cerca.
  const { error } = await admin
    .from("voice_calls")
    .update({
      status: "ended",
      end_reason: "user_ended",
      ended_at: entrada.endedAt.toISOString(),
      duration_ms: durationMs,
      transcript: entrada.transcript,
    })
    .eq("id", entrada.voiceCallId)
    .eq("organization_id", entrada.organizationId);

  // Pedir resumo de ligação que não ficou "ended" faria o handler pular.
  if (error) return { resumoPedido: false };
  if (lerTranscricao(entrada.transcript).length === 0) return { resumoPedido: false };

  const pedido = await pedirResumoDaLigacao(admin, {
    organizationId: entrada.organizationId,
    voiceCallId: entrada.voiceCallId,
  });
  return { resumoPedido: pedido.ok };
}
