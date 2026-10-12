import { z } from "zod";

// Contrato ÚNICO do payload da atividade `call_summarized`: o handler valida o
// que o modelo devolveu contra ele antes de gravar, e a timeline valida de novo
// ao ler — payload jsonb que a tela lê por caminho solto é o anti-pattern 6.
export const RESUMO_DA_LIGACAO_VERSAO = 1 as const;

export const LIMITE_DO_RESUMO = 600;
export const LIMITE_DE_ITENS = 5;
export const LIMITE_DO_ITEM = 200;

const item = z.string().trim().min(1).max(LIMITE_DO_ITEM);

// O que o modelo devolve. O resto do payload (ids, duração, contagem de
// turnos) vem do banco, nunca do modelo.
export const SaidaDoResumoSchema = z.object({
  resumo: z.string().trim().min(1).max(LIMITE_DO_RESUMO),
  pontos: z.array(item).max(LIMITE_DE_ITENS),
  compromissos_do_cliente: z.array(item).max(LIMITE_DE_ITENS),
  proximo_passo_sugerido: item.nullable(),
});

export type SaidaDoResumo = z.infer<typeof SaidaDoResumoSchema>;

export const ResumoDaLigacaoPayloadSchema = SaidaDoResumoSchema.extend({
  versao: z.literal(RESUMO_DA_LIGACAO_VERSAO),
  voice_call_id: z.uuid(),
  provider: z.enum(["sip", "wacalls"]),
  duration_ms: z.number().int().nonnegative().nullable(),
  turnos: z.number().int().positive(),
});

export type ResumoDaLigacaoPayload = z.infer<typeof ResumoDaLigacaoPayloadSchema>;
