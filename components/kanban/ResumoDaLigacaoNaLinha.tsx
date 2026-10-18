"use client";

import { useId, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { ResumoDaLigacaoPayloadSchema } from "@/lib/calls/resumo-da-ligacao.schema";
import { formatarDuracao } from "@/lib/metrics/atrito";
import { CaretDown, CaretRight } from "@/lib/ui/icons";

type ResumoDaLigacaoNaLinhaProps = {
  tipo: string;
  payload: unknown;
  // A timeline do negócio guarda num estado só o que está aberto; as outras
  // telas não têm esse estado e deixam o componente cuidar do próprio.
  aberto?: boolean;
  aoAlternar?: () => void;
};

function Secao({ titulo, itens }: { titulo: string; itens: string[] }) {
  if (itens.length === 0) return null;
  return (
    <div>
      <p className="font-medium text-text-muted">{titulo}</p>
      <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
        {itens.map((texto, indice) => (
          <li key={indice}>{texto}</li>
        ))}
      </ul>
    </div>
  );
}

// O mesmo bloco nas três telas que listam `crm_lead_activities`. O payload é
// relido pelo schema compartilhado com o handler: fora do contrato (versão
// nova, anonimizado), a linha fica só com o rótulo.
export function ResumoDaLigacaoNaLinha({
  tipo,
  payload,
  aberto,
  aoAlternar,
}: ResumoDaLigacaoNaLinhaProps) {
  const t = useT();
  const idDoBloco = useId();
  const [abertoAqui, setAbertoAqui] = useState(false);

  if (tipo !== "call_summarized") return null;
  const lido = ResumoDaLigacaoPayloadSchema.safeParse(payload);
  if (!lido.success) return null;
  const resumo = lido.data;

  const estaAberto = aberto ?? abertoAqui;
  const alternar = aoAlternar ?? (() => setAbertoAqui((anterior) => !anterior));
  const Seta = estaAberto ? CaretDown : CaretRight;

  return (
    <div className="mt-1">
      <div className="flex items-center gap-2 text-[11px] text-text-muted">
        <button
          type="button"
          onClick={alternar}
          aria-expanded={estaAberto}
          aria-controls={estaAberto ? idDoBloco : undefined}
          className="inline-flex items-center gap-1 rounded-sm text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:outline-hidden"
        >
          <Seta size={16} weight="regular" aria-hidden />
          {estaAberto ? t("Ocultar resumo") : t("Ver resumo")}
        </button>
        {resumo.duration_ms !== null && (
          <span>
            {t("Duração")}{" "}
            <span className="font-mono tabular-nums">
              {formatarDuracao(resumo.duration_ms / 1000)}
            </span>
          </span>
        )}
      </div>
      {estaAberto && (
        // Rótulo próprio de leitura da IA: o resumo parafraseia o cliente, e
        // quem age em cima dele precisa saber que deve conferir a transcrição.
        <div
          id={idDoBloco}
          role="region"
          aria-label={t("Resumo da IA — confira na transcrição")}
          className="mt-1.5 space-y-2 rounded-md border border-border bg-surface p-2 text-xs text-text"
        >
          <p className="whitespace-pre-line">{resumo.resumo}</p>
          <Secao titulo={t("Pontos")} itens={resumo.pontos} />
          <Secao titulo={t("Compromissos do cliente")} itens={resumo.compromissos_do_cliente} />
          {resumo.proximo_passo_sugerido !== null && (
            <div>
              <p className="font-medium text-text-muted">{t("Próximo passo sugerido")}</p>
              <p className="mt-0.5">{resumo.proximo_passo_sugerido}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
