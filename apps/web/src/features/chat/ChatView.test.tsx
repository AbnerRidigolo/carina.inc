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
