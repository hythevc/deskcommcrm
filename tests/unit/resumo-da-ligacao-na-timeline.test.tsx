import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TimelineView } from "@/components/contacts/TimelineView";
import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";
import { LeadTimeline } from "@/components/kanban/LeadTimeline";
import type { TimelineItemView } from "@/lib/types/contacts";

// O resumo da ligação chega às três telas que listam `crm_lead_activities`:
// a linha do tempo do negócio, a do contato e o painel do inbox. Em todas ele
// fica atrás de um botão, é apresentado como leitura da IA e some quando o
// payload não bate com o contrato.

const LIGACAO_ID = "00000000-0000-4000-8000-0000000000c1";
const AGENTE_ID = "00000000-0000-4000-8000-0000000000a1";
const CONTATO_ID = "00000000-0000-4000-8000-0000000000b1";

const PAYLOAD = {
  versao: 1,
  voice_call_id: LIGACAO_ID,
  provider: "sip",
  duration_ms: 252_000,
  turnos: 14,
  resumo: "O cliente pediu a proposta do plano anual e quer começar no mês que vem.",
  pontos: ["A equipe tem cinco atendentes", "Hoje responde tudo pelo celular"],
  compromissos_do_cliente: ['O cliente disse: "mando a planilha de contatos até sexta"'],
  proximo_passo_sugerido: "Enviar a proposta do plano anual até quinta",
};

function linha(sobrescreve: Partial<TimelineItemView> = {}): TimelineItemView {
  return {
    id: "00000000-0000-4000-8000-0000000000d1",
    organization_id: "00000000-0000-4000-8000-0000000000e1",
    lead_id: "00000000-0000-4000-8000-0000000000f1",
    contact_id: CONTATO_ID,
    source_module: "voice_calls",
    source_id: LIGACAO_ID,
    type: "call_summarized",
    payload: PAYLOAD,
    metadata: {},
    performed_at: "2026-10-12T14:00:30Z",
    performed_by_user_id: null,
    actor_kind: "ai",
    actor_agent_id: AGENTE_ID,
    actor_agent_name: "Agente de vendas",
    reason: "Resumo da IA — confira na transcrição",
    evidence: { llm_call_ids: ["00000000-0000-4000-8000-000000000011"] },
    ...sobrescreve,
  };
}

function timelineDoNegocio(itens: TimelineItemView[]) {
  return render(
    <LeadTimeline itens={itens} chegouAoVivo={new Set()} isLoading={false} isError={false} />,
  );
}

describe("resumo da ligação na linha do tempo do negócio", () => {
  it("diz que é leitura da IA e deixa o resumo fechado até a pessoa abrir", () => {
    timelineDoNegocio([linha()]);

    expect(screen.getByText("Resumo da ligação")).toBeInTheDocument();
    expect(screen.getByText("Resumo da IA — confira na transcrição")).toBeInTheDocument();
    const botao = screen.getByRole("button", { name: "Ver resumo" });
    expect(botao).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(PAYLOAD.resumo)).not.toBeInTheDocument();
  });

  it("abre o resumo com os pontos, os compromissos e o próximo passo, e fecha pelo mesmo botão", async () => {
    const user = userEvent.setup();
    timelineDoNegocio([linha()]);

    await user.click(screen.getByRole("button", { name: "Ver resumo" }));

    const botao = screen.getByRole("button", { name: "Ocultar resumo" });
    expect(botao).toHaveAttribute("aria-expanded", "true");
    // O bloco se apresenta como leitura da IA mesmo sem o `reason` da linha.
    const bloco = screen.getByRole("region", { name: "Resumo da IA — confira na transcrição" });
    expect(within(bloco).getByText(PAYLOAD.resumo)).toBeInTheDocument();
    expect(within(bloco).getByText("Pontos")).toBeInTheDocument();
    expect(within(bloco).getByText("A equipe tem cinco atendentes")).toBeInTheDocument();
    expect(within(bloco).getByText("Hoje responde tudo pelo celular")).toBeInTheDocument();
    expect(within(bloco).getByText("Compromissos do cliente")).toBeInTheDocument();
    expect(
      within(bloco).getByText('O cliente disse: "mando a planilha de contatos até sexta"'),
    ).toBeInTheDocument();
    expect(within(bloco).getByText("Próximo passo sugerido")).toBeInTheDocument();
    expect(
      within(bloco).getByText("Enviar a proposta do plano anual até quinta"),
    ).toBeInTheDocument();

    await user.click(botao);
    expect(screen.getByRole("button", { name: "Ver resumo" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText(PAYLOAD.resumo)).not.toBeInTheDocument();
  });

  it("mostra quanto a ligação durou", () => {
    timelineDoNegocio([linha()]);
    expect(screen.getByText("4min")).toBeInTheDocument();
  });

  it("listas vazias e próximo passo nulo não viram títulos sem conteúdo", async () => {
    const user = userEvent.setup();
    timelineDoNegocio([
      linha({
        payload: {
          ...PAYLOAD,
          duration_ms: null,
          pontos: [],
          compromissos_do_cliente: [],
          proximo_passo_sugerido: null,
        },
      }),
    ]);

    await user.click(screen.getByRole("button", { name: "Ver resumo" }));

    expect(screen.getByText(PAYLOAD.resumo)).toBeInTheDocument();
    expect(screen.queryByText("Pontos")).not.toBeInTheDocument();
    expect(screen.queryByText("Compromissos do cliente")).not.toBeInTheDocument();
    expect(screen.queryByText("Próximo passo sugerido")).not.toBeInTheDocument();
    expect(screen.queryByText("4min")).not.toBeInTheDocument();
  });

  it("payload fora do contrato mostra só o rótulo da linha", () => {
    timelineDoNegocio([linha({ payload: { ...PAYLOAD, versao: 2 } })]);

    expect(screen.getByText("Resumo da ligação")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ver resumo" })).not.toBeInTheDocument();
    expect(screen.queryByText(PAYLOAD.resumo)).not.toBeInTheDocument();
  });

  it("payload apagado pela anonimização não deixa botão para abrir nada", () => {
    timelineDoNegocio([linha({ payload: {}, reason: null })]);

    expect(screen.getByText("Resumo da ligação")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ver resumo" })).not.toBeInTheDocument();
  });

  it("outra linha com payload parecido não ganha o bloco do resumo", () => {
    timelineDoNegocio([linha({ type: "voice_call", reason: null })]);

    expect(screen.getByText("Chamada de voz")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ver resumo" })).not.toBeInTheDocument();
  });

  it("o resumo fica visível ao lado do bloco do agente no mesmo minuto", async () => {
    const user = userEvent.setup();
    // O agente responde, encerra a ligação e o resumo nasce no mesmo minuto:
    // as duas linhas de relato colapsam, o resumo não.
    timelineDoNegocio([
      linha({
        id: "00000000-0000-4000-8000-0000000000d2",
        type: "ai_turn",
        payload: {},
        reason: "Respondeu sobre o plano anual",
        performed_at: "2026-10-12T14:00:00Z",
      }),
      linha({
        id: "00000000-0000-4000-8000-0000000000d3",
        type: "ai_turn",
        payload: {},
        reason: "Combinou de mandar a proposta",
        performed_at: "2026-10-12T14:00:10Z",
      }),
      linha(),
    ]);

    const grupo = screen.getByRole("button", { name: /2 ações/ });
    expect(grupo).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("button", { name: "Ver resumo" }));
    expect(screen.getByText(PAYLOAD.resumo)).toBeInTheDocument();
    // Abrir o resumo não abre o bloco vizinho: cada um tem a sua chave.
    expect(grupo).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Respondeu sobre o plano anual")).not.toBeInTheDocument();
  });
});

const timelineDoContato = vi.fn();
vi.mock("@/hooks/contacts/useTimeline", () => ({
  useTimeline: (...args: unknown[]) => timelineDoContato(...args),
}));

describe("resumo da ligação na linha do tempo do contato", () => {
  beforeEach(() => {
    timelineDoContato.mockReset();
  });

  it("abre o mesmo resumo pelo mesmo botão", async () => {
    const user = userEvent.setup();
    timelineDoContato.mockReturnValue({
      data: { pages: [{ data: [linha()] }] },
      isLoading: false,
      isError: false,
      hasNextPage: false,
    });
    render(<TimelineView contactId={CONTATO_ID} />);

    expect(screen.getByText("Resumo da IA — confira na transcrição")).toBeInTheDocument();
    expect(screen.queryByText(PAYLOAD.resumo)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ver resumo" }));
    expect(screen.getByText(PAYLOAD.resumo)).toBeInTheDocument();
    expect(screen.getByText("Enviar a proposta do plano anual até quinta")).toBeInTheDocument();
  });
});

const getDaApi = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => getDaApi(...args),
    post: vi.fn(),
    patch: vi.fn(),
  },
}));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({ data: null, isError: false }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useUpdateConversationTags: () => ({ mutate: vi.fn(), isPending: false }),
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => ({ user: { support: null } }) }));

describe("resumo da ligação no painel do inbox", () => {
  beforeEach(() => {
    getDaApi.mockReset();
  });

  it("a atividade do contato abre o resumo da ligação", async () => {
    const user = userEvent.setup();
    const { actor_agent_name: _nome, ...atividade } = linha();
    void _nome;
    getDaApi.mockResolvedValue({
      data: {
        leads: [],
        orders: [],
        activities: [{ ...atividade, performed_by_name: null }],
        demandas: [],
      },
    });
    const conversa = {
      id: "cv-1",
      organization_id: "org-1",
      contact_id: CONTATO_ID,
      tags: [],
      contacts: { id: CONTATO_ID, display_name: "Contato de teste", name: null, tags: [] },
    } as unknown as React.ComponentProps<typeof CRMSidePanel>["conversation"];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CRMSidePanel conversation={conversa} />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "Ver resumo" }));
    expect(screen.getByText(PAYLOAD.resumo)).toBeInTheDocument();
  });
});
