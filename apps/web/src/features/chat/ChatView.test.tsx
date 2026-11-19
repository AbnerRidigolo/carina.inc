import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createEventBus, type PanelSignal } from "../../state/event-bus";
import { setApiKey } from "../../state/session";
import type { FakeWebSocket } from "../../test/fake-websocket";
import { TEST_KEY, doneEvent, emit, openSocket, ticketHandler, use } from "../../test/helpers";
import { ChatView } from "./ChatView";

async function mount() {
  setApiKey(TEST_KEY);
  use(ticketHandler());
  const bus = createEventBus<PanelSignal>();
  const seen: PanelSignal[] = [];
  bus.subscribe((s) => seen.push(s));
  const view = render(<ChatView clientId="cliente-moderado" bus={bus} />);
  const socket = await openSocket();
  await screen.findByText(/conectado/i);
  return { socket, seen, view };
}

async function ask(socket: FakeWebSocket, text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Mensagem"), text);
  await user.click(screen.getByRole("button", { name: "Enviar" }));
  expect(socket.sent.at(-1)).toBeDefined();
  return user;
}

describe("ChatView", () => {
  it("plan → agent_started → token×3 → agent_result → done renderiza o card do Insight e o custo", async () => {
    const { socket } = await mount();
    await ask(socket, "Como está minha carteira?");
    expect(JSON.parse(socket.sent[0] ?? "")).toEqual({
      clientId: "cliente-moderado",
      message: "Como está minha carteira?",
    });

    emit(
      socket,
      {
        type: "plan",
        plan: { complexity: "simples", agents: ["insight"], wantsExecution: false, rationale: "r" },
      },
      { type: "agent_started", agent: "insight" },
    );
    const card = screen.getByRole("region", { name: /insight/i });
    expect(within(card).getByText(/pensando/i)).toBeInTheDocument();

    emit(
      socket,
      { type: "token", agent: "insight", text: "Sua carteira " },
      { type: "token", agent: "insight", text: "está bem " },
      { type: "token", agent: "insight", text: "diversificada." },
    );
    expect(within(card).getByText("Sua carteira está bem diversificada.")).toBeInTheDocument();
    expect(within(card).queryByText(/pensando/i)).not.toBeInTheDocument();

    emit(
      socket,
      { type: "agent_result", agent: "insight", result: "Sua carteira está bem diversificada." },
      doneEvent(),
    );
    expect(within(card).getByText("Sua carteira está bem diversificada.")).toBeInTheDocument();
    expect(screen.getByText(/R\$\s7,50/)).toBeInTheDocument();
    expect(screen.getByLabelText("Mensagem")).toBeEnabled();
  });

  it("predictor vira tabela de cenários e risk mostra o VaR em R$", async () => {
    const { socket } = await mount();
    await ask(socket, "projeta");
    emit(
      socket,
      { type: "agent_started", agent: "predictor" },
      {
        type: "agent_result",
        agent: "predictor",
        result: {
          scenarios: [
            {
              name: "Base",
              horizonMonths: 12,
              assumptions: ["Selic estável"],
              projectedNetFlowBrl: "12345.60",
              confidence: 0.7,
            },
            {
              name: "Estresse",
              horizonMonths: 24,
              assumptions: [],
              projectedNetFlowBrl: "-500.00",
              confidence: 0.4,
            },
          ],
          narrative: "Narrativa do predictor",
        },
      },
      { type: "agent_started", agent: "risk" },
      {
        type: "agent_result",
        agent: "risk",
        result: {
          driftPct: 3.5,
          valueAtRiskBrl: "8200.00",
          topCorrelations: ["PETR4~VALE3"],
          stressFindings: ["queda de 20% na bolsa"],
          rebalanceSuggestions: ["reduzir renda variável"],
        },
      },
    );
    const table = screen.getByRole("table", { name: /cen[aá]rios/i });
    expect(within(table).getByText("Base")).toBeInTheDocument();
    expect(within(table).getByText(/R\$\s12\.345,60/)).toBeInTheDocument();
    expect(within(table).getByText(/-R\$\s500,00/)).toBeInTheDocument();
    expect(screen.getByText("Narrativa do predictor")).toBeInTheDocument();
    const risk = screen.getByRole("region", { name: /risk/i });
    expect(within(risk).getByText(/R\$\s8\.200,00/)).toBeInTheDocument();
    expect(within(risk).getByText("PETR4~VALE3")).toBeInTheDocument();
  });

  it("cartão do strategist mostra a alocação e os marcos", async () => {
    const { socket } = await mount();
    await ask(socket, "plano");
    emit(
      socket,
      { type: "agent_started", agent: "strategist" },
      {
        type: "agent_result",
        agent: "strategist",
        result: {
          targetAllocation: [
            { assetClass: "renda fixa", pct: 60 },
            { assetClass: "exterior", pct: 40 },
          ],
          milestones: [{ goal: "independência financeira", byYear: 2040, successProbability: 0.7 }],
          assumptions: ["retorno real de 4% ao ano"],
          narrative: "Narrativa do strategist",
        },
      },
    );
    const card = screen.getByRole("region", { name: /strategist/i });
    const table = within(card).getByRole("table", { name: /aloca[cç][aã]o/i });
    expect(within(table).getByText("renda fixa")).toBeInTheDocument();
    expect(within(table).getByText("60%")).toBeInTheDocument();
    expect(within(card).getByText(/independência financeira/)).toBeInTheDocument();
    expect(within(card).getByText(/2040/)).toBeInTheDocument();
    expect(within(card).getByText(/70%/)).toBeInTheDocument();
    expect(within(card).getByText("retorno real de 4% ao ano")).toBeInTheDocument();
    expect(within(card).getByText("Narrativa do strategist")).toBeInTheDocument();
  });

  it("cartão tributário mostra o IR em R$ e o aviso de contador só com consultAccountant", async () => {
    const { socket } = await mount();
    await ask(socket, "imposto");
    const base = {
      estimatedTaxBrl: "12000.00",
      harvestingOpportunities: ["Compensar prejuízos"],
      offshoreVsBr: "Comparar offshore e Brasil",
      actions: ["Revisar prejuízos"],
      narrative: "Narrativa tributária",
    };
    emit(
      socket,
      { type: "agent_started", agent: "tax" },
      { type: "agent_result", agent: "tax", result: { ...base, consultAccountant: true } },
    );
    const card = screen.getByRole("region", { name: /tribut[aá]rio/i });
    expect(within(card).getByText(/R\$\s12\.000,00/)).toBeInTheDocument();
    expect(within(card).getByText("Compensar prejuízos")).toBeInTheDocument();
    expect(within(card).getByText("Revisar prejuízos")).toBeInTheDocument();
    expect(within(card).getByText("Consulte um contador antes de agir.")).toBeInTheDocument();
  });

  it("cartão tributário sem consultAccountant não mostra o aviso de contador", async () => {
    const { socket } = await mount();
    await ask(socket, "imposto");
    emit(
      socket,
      { type: "agent_started", agent: "tax" },
      {
        type: "agent_result",
        agent: "tax",
        result: {
          estimatedTaxBrl: "0.00",
          harvestingOpportunities: [],
          offshoreVsBr: "n/a",
          actions: [],
          consultAccountant: false,
          narrative: "Sem imposto",
        },
      },
    );
    const card = screen.getByRole("region", { name: /tribut[aá]rio/i });
    expect(within(card).getByText("Sem imposto")).toBeInTheDocument();
    expect(within(card).queryByText(/Consulte um contador/)).not.toBeInTheDocument();
  });

  it("cartão do assessor numera as perguntas e avisa que nada foi enviado", async () => {
    const { socket } = await mount();
    await ask(socket, "fale com o assessor");
    emit(
      socket,
      { type: "agent_started", agent: "assessor_liaison" },
      {
        type: "agent_result",
        agent: "assessor_liaison",
        result: {
          questions: ["Qual a taxa atual?", "Há carência?"],
          sharedData: ["Revela o interesse em renda fixa.", "Revela o horizonte do cliente."],
          narrative: "Rascunho",
        },
      },
    );
    const card = screen.getByRole("region", { name: /assessor/i });
    const [first, second, ...rest] = within(card).getAllByRole("listitem");
    expect(rest).toHaveLength(0);
    if (!first || !second) throw new Error("esperava duas perguntas");
    expect(within(first).getByText(/Qual a taxa atual\?/)).toBeInTheDocument();
    expect(within(first).getByText(/Revela o interesse em renda fixa\./)).toBeInTheDocument();
    expect(within(second).getByText(/Há carência\?/)).toBeInTheDocument();
    expect(card.querySelector("ol")).not.toBeNull();
    expect(within(card).getByText("Rascunho: nada foi enviado ao assessor.")).toBeInTheDocument();
  });

  it("cartão do assessor mostra os dados compartilhados além das perguntas", async () => {
    const { socket } = await mount();
    await ask(socket, "fale com o assessor");
    emit(
      socket,
      { type: "agent_started", agent: "assessor_liaison" },
      {
        type: "agent_result",
        agent: "assessor_liaison",
        result: {
          questions: ["Qual a taxa atual?"],
          sharedData: ["Revela o interesse em renda fixa.", "Revela o saldo total da carteira."],
          narrative: "Rascunho",
        },
      },
    );
    const card = screen.getByRole("region", { name: /assessor/i });
    expect(within(card).getByText("Outros dados compartilhados")).toBeInTheDocument();
    expect(within(card).getByText("Revela o saldo total da carteira.")).toBeInTheDocument();
  });

  it("cartão do assessor avisa quando a pergunta não tem o que revela", async () => {
    const { socket } = await mount();
    await ask(socket, "fale com o assessor");
    emit(
      socket,
      { type: "agent_started", agent: "assessor_liaison" },
      {
        type: "agent_result",
        agent: "assessor_liaison",
        result: {
          questions: ["Primeira?", "Segunda?"],
          sharedData: [""],
          narrative: "Rascunho",
        },
      },
    );
    const card = screen.getByRole("region", { name: /assessor/i });
    expect(within(card).getAllByText("Não informado o que esta pergunta revela.")).toHaveLength(2);
    expect(within(card).queryByText("Outros dados compartilhados")).not.toBeInTheDocument();
  });

  it("cartão de pesquisa mostra o texto", async () => {
    const { socket } = await mount();
    await ask(socket, "pesquise");
    emit(
      socket,
      { type: "agent_started", agent: "researcher" },
      { type: "agent_result", agent: "researcher", result: "Segundo a base, confiança média." },
    );
    const card = screen.getByRole("region", { name: /pesquisa/i });
    expect(within(card).getByText("Segundo a base, confiança média.")).toBeInTheDocument();
  });

  it("resultado fora do schema cai no render genérico", async () => {
    const { socket } = await mount();
    await ask(socket, "x");
    emit(socket, {
      type: "agent_result",
      agent: "strategist",
      result: { targetAllocation: [], segredo: "ZZZ-conteudo-cru" },
    });
    const card = screen.getByRole("region", { name: /strategist/i });
    expect(within(card).getByText(/formato inesperado/i)).toBeInTheDocument();
    expect(screen.queryByText(/ZZZ-conteudo-cru/)).not.toBeInTheDocument();
  });

  it("executor que não pôde propor a ordem mostra a frase do servidor no card", async () => {
    const { socket } = await mount();
    await ask(socket, "compre 4 ações de ABEV3");
    const message =
      "Não foi possível propor a ordem: o ativo não foi encontrado na base de cotações.";
    emit(
      socket,
      { type: "agent_started", agent: "executor" },
      {
        type: "agent_result",
        agent: "executor",
        result: { failed: true, reason: "unknown_asset", message },
      },
      doneEvent(),
    );
    const card = screen.getByRole("region", { name: /executor/i });
    expect(within(card).getByText(message)).toBeInTheDocument();
    expect(within(card).queryByText(/não conseguiu concluir/)).not.toBeInTheDocument();
  });

  it("falha sem frase mantém o aviso genérico", async () => {
    const { socket } = await mount();
    await ask(socket, "projeta");
    emit(
      socket,
      { type: "agent_started", agent: "risk" },
      { type: "agent_result", agent: "risk", result: { failed: true } },
      doneEvent(),
    );
    const card = screen.getByRole("region", { name: /risk/i });
    expect(within(card).getByText(/não conseguiu concluir a análise/)).toBeInTheDocument();
  });

  it("resultado fora do schema do agente vira aviso, nunca é renderizado", async () => {
    const { socket } = await mount();
    await ask(socket, "x");
    emit(socket, {
      type: "agent_result",
      agent: "risk",
      result: { valueAtRiskBrl: "<b>oops</b>", segredo: "ZZZ-conteudo-cru" },
    });
    const risk = screen.getByRole("region", { name: /risk/i });
    expect(within(risk).getByText(/formato inesperado/i)).toBeInTheDocument();
    expect(screen.queryByText(/ZZZ-conteudo-cru/)).not.toBeInTheDocument();
  });

  it("texto do agente é sempre texto: <img onerror>/<script> não viram elementos", async () => {
    const { socket, view } = await mount();
    await ask(socket, "<img src=x onerror=alert(1)>");
    const evil =
      '<img src=x onerror="alert(1)"><script>alert(2)</script> [link](javascript:alert(3)) https://evil.example';
    emit(
      socket,
      { type: "agent_started", agent: "navigator" },
      { type: "token", agent: "navigator", text: evil },
      { type: "agent_result", agent: "navigator", result: evil },
    );
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.querySelector("a")).toBeNull();
    expect(screen.getAllByText(/<img src=x onerror="alert\(1\)">/).length).toBeGreaterThan(0);
  });

  it("import_progress e import_finished do socket chegam ao barramento dos painéis", async () => {
    const { socket, seen } = await mount();
    const progress = {
      type: "import_progress",
      importJobId: "j1",
      stage: "parsing",
      processed: 5,
      total: 10,
    } as const;
    const finished = { type: "import_finished", importJobId: "j1", status: "done" } as const;
    emit(socket, progress, finished);
    expect(seen).toContainEqual(progress);
    expect(seen).toContainEqual(finished);
  });

  it("thread_busy mostra mensagem clara e libera o campo", async () => {
    const { socket } = await mount();
    await ask(socket, "oi");
    emit(socket, { type: "error", code: "thread_busy", traceId: "tr-9" });
    expect(screen.getByRole("alert")).toHaveTextContent(/em andamento/i);
    expect(screen.getByRole("alert")).toHaveTextContent("tr-9");
    expect(screen.getByLabelText("Mensagem")).toBeEnabled();
  });

  it("error unauthenticated mostra Chave inválida/expirada e desabilita o envio", async () => {
    const { socket } = await mount();
    await ask(socket, "oi");
    emit(socket, { type: "error", code: "unauthenticated", traceId: "t" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/chave inválida/i);
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
  });

  it("não deixa enviar outra mensagem enquanto o turno não termina e reaproveita o threadId", async () => {
    const { socket } = await mount();
    const user = await ask(socket, "primeira");
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
    expect(screen.getByLabelText("Mensagem")).toBeDisabled();
    emit(socket, doneEvent({ threadId: "t:c:abc" }));
    await user.type(screen.getByLabelText("Mensagem"), "segunda");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[1] ?? "")).toMatchObject({
      message: "segunda",
      threadId: "t:c:abc",
    });
  });

  it("publica os eventos no barramento (inbox/uso escutam) e sinaliza o socket aberto", async () => {
    const { socket, seen } = await mount();
    emit(socket, { type: "approval_executed", approvalId: "a", status: "succeeded" });
    expect(seen.map((s) => s.type)).toEqual(["socket_open", "approval_executed"]);
  });

  it("desmontar fecha o socket e não deixa nada pendente", async () => {
    const { socket, view } = await mount();
    view.unmount();
    expect(socket.closeCalls).toHaveLength(1);
    expect(socket.onmessage).toBeNull();
  });

  it("queda do socket no meio do turno marca o turno como interrompido e libera o campo ao reconectar", async () => {
    const { socket } = await mount();
    await ask(socket, "oi");
    emit(
      socket,
      { type: "agent_started", agent: "navigator" },
      { type: "token", agent: "navigator", text: "Par" },
    );
    act(() => socket.serverClose(1006));
    expect(await screen.findByRole("alert")).toHaveTextContent(/conexão caiu/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/caixa de entrada/i);
    // A queda é local (não veio do servidor): não há traceId, e o sufixo vazio não aparece.
    expect(screen.getByRole("alert")).not.toHaveTextContent(/rastreio/i);
    const second = await openSocket(1);
    await screen.findByText(/conectado/i);
    expect(screen.getByLabelText("Mensagem")).toBeEnabled();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Mensagem"), "de novo");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(second.sent).toHaveLength(1);
  });

  it("4401 no meio do turno interrompe o turno; 4401 repetido mostra chave inválida", async () => {
    const { socket } = await mount();
    await ask(socket, "oi");
    emit(socket, { type: "token", agent: "navigator", text: "x" });
    act(() => socket.serverClose(4401, "unauthorized"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/conexão caiu/i);
    const second = await openSocket(1);
    act(() => second.serverClose(4401, "unauthorized"));
    expect(await screen.findByText(/chave inválida/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Mensagem")).toBeDisabled();
  });
});
