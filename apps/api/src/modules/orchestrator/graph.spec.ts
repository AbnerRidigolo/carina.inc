/**
 * Grafo do orquestrador em LLM_MODE=mock, com MemorySaver (injetado) e dependências falsas:
 * roteamento, especialistas em paralelo, falhas, interrupt de aprovação e retomada.
 */
import { randomUUID } from "node:crypto";
import type { BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { type ApprovalView, type ChatEvent, ChatEventSchema } from "@carina/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelsConfig } from "../../core/config/models-config.js";
import { TenantContext } from "../../core/context/tenant-context.js";
import {
  ApprovalConflictError,
  NotFoundError,
  ValidationError,
} from "../../core/errors/domain-errors.js";
import { agentFailure, type AgentInput } from "../agents/agent.js";
import { AgentRegistry } from "../agents/agent-registry.js";
import { registerAgentMockResponders } from "../agents/mock-responders.js";
import type { SearchResult } from "../knowledge/knowledge.service.js";
import { type MockResponder, MockResponderRegistry } from "../llm/mock-models.js";
import { ModelFactory, type LlmEnv } from "../llm/model-factory.js";
import { heuristicPlan } from "./heuristic.js";
import { registerOrchestratorMockResponders } from "./orchestrator.module.js";
import { OrchestratorService } from "./orchestrator.service.js";
import { MAX_HISTORY_MESSAGES } from "./state.js";

const ENV: LlmEnv = {
  LLM_MODE: "mock",
  OPENROUTER_API_KEY: undefined,
  GROQ_API_KEY: undefined,
  NVIDIA_API_KEY: undefined,
  OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
  GROQ_BASE_URL: "https://api.groq.com/openai/v1",
  NVIDIA_BASE_URL: "https://integrate.api.nvidia.com/v1",
};
const CONFIG: ModelsConfig = {
  roles: {
    conversational: { primary: "openrouter/a:free", fallback: [] },
    reasoning: { primary: "openrouter/r:free", fallback: [] },
  },
  embeddings: { primary: "nvidia/nv-embedqa-e5-v5", dimensions: 1024 },
  limits: { rpm: 20, timeoutMs: 1000, temperature: 0.2 },
};

const T = randomUUID();
const C = randomUUID();
const OTHER_T = randomUUID();
const OTHER_C = randomUUID();
const APPROVAL = "a".repeat(64);

const KNOWLEDGE: SearchResult = {
  chunks: [
    { chunkId: "c1", documentId: "d1", title: "Carteira 2026", content: "PETR4 30%", score: 1 },
  ],
  entities: [],
  neighbors: [],
};

const asClient = <R>(fn: () => Promise<R>, tenantId = T, clientId = C) =>
  TenantContext.run({ tenantId, clientId }, fn);
const newThread = () => `${T}:${C}:${randomUUID()}`;

const approvalView = (id: string): ApprovalView => ({
  id,
  clientId: "cli-1",
  agent: "executor",
  action: "place_trade",
  risk: "irreversible",
  payload: { side: "buy", assetCode: "PETR4", quantity: 100 },
  valueBrl: "3000.00",
  status: "pending",
  expiresAt: "2026-11-13T00:00:00.000Z",
  createdAt: "2026-11-12T00:00:00.000Z",
});

function setup(responders: Record<string, MockResponder> = {}) {
  const mocks = new MockResponderRegistry();
  // Os de teste entram antes: os registros padrão pulam chaves já registradas.
  for (const [k, r] of Object.entries(responders)) mocks.register(k, r);
  registerAgentMockResponders(mocks);
  registerOrchestratorMockResponders(mocks);
  const models = new ModelFactory(ENV, CONFIG, { eval: vi.fn() }, () => 0, mocks);
  // Banco simulado: status da aprovação e cerca de execução (como o InboxService real).
  const db: {
    status: ApprovalView["status"];
    executed: { status: "succeeded" | "started"; result?: unknown } | null;
  } = { status: "pending", executed: null };
  const wins = { n: 0 };
  const inbox = {
    request: vi.fn(async () => ({ approvalId: APPROVAL, created: true })),
    executeOnce: vi.fn(async (): Promise<{ status: "succeeded" | "skipped"; result?: unknown }> => {
      if (db.status !== "approved" || db.executed) return { status: "skipped" };
      wins.n++;
      db.executed = { status: "succeeded", result: { orderId: "SIM-1" } };
      return db.executed as { status: "succeeded"; result: unknown };
    }),
    executionOf: vi.fn(async () => db.executed),
    expireIfDue: vi.fn(async () => false),
    get: vi.fn(async (id: string) => ({ ...approvalView(id), status: db.status })),
  };
  const agentLogger = { warn: vi.fn(), error: vi.fn() };
  const agents = new AgentRegistry(models, inbox as never, agentLogger);
  const knowledge = { search: vi.fn(async (): Promise<SearchResult> => KNOWLEDGE) };
  const executed = vi.fn(async (payload: Record<string, unknown>) => ({ ok: true, payload }));
  const executors = { get: vi.fn((action: string) => (action ? executed : undefined)) };
  const streams = { publish: vi.fn(async () => "1-0") };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const checkpointer = new MemorySaver();
  const make = () =>
    new OrchestratorService(
      models,
      agents,
      knowledge as never,
      inbox as never,
      executors as never,
      streams as never,
      checkpointer,
      logger,
    );
  /** Quantas vezes a "cerca" deixou executar de fato. */
  const executeCount = () => wins.n;
  return {
    executeCount,
    db,
    mocks,
    models,
    inbox,
    agents,
    knowledge,
    executed,
    executors,
    streams,
    logger,
    make,
  };
}

async function collect(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const turn = (svc: OrchestratorService, threadId: string, question: string) =>
  asClient(() => collect(svc.stream({ threadId, question })));

const types = (events: ChatEvent[]) => events.map((e) => e.type);

describe("OrchestratorService (grafo, mock + MemorySaver)", () => {
  let s: ReturnType<typeof setup>;
  let svc: OrchestratorService;

  beforeEach(() => {
    s = setup();
    svc = s.make();
  });

  it("todo evento emitido é um ChatEvent válido e não há `done` (é do ChatService)", async () => {
    const events = await turn(svc, newThread(), "projeção e risco da carteira");
    for (const e of events) expect(ChatEventSchema.safeParse(e).success).toBe(true);
    expect(types(events)).not.toContain("done");
  });

  it("pergunta simples: só answer; results vazio; tokens formam a resposta", async () => {
    const threadId = newThread();
    const events = await turn(svc, threadId, "olá");
    const plan = events.find((e) => e.type === "plan");
    expect(plan).toMatchObject({ plan: { complexity: "simples", agents: [] } });
    expect(events.filter((e) => e.type === "agent_started")).toEqual([
      { type: "agent_started", agent: "navigator" },
    ]);
    const results = events.filter((e) => e.type === "agent_result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ agent: "navigator" });

    const state = await asClient(() => svc.finalState(threadId));
    expect(state.results).toEqual({});
    expect(state.errors).toEqual({});
    expect(typeof state.answer).toBe("string");
    const tokens = events.flatMap((e) => (e.type === "token" ? [e.text] : []));
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.join("")).toBe(state.answer);
    expect(state.messages.map((m) => m.getType())).toEqual(["human", "ai"]);
    expect(s.inbox.request).not.toHaveBeenCalled();
  });

  it("projeção e risco da carteira: 3 especialistas em paralelo e síntese por último", async () => {
    const threadId = newThread();
    const events = await turn(svc, threadId, "projeção e risco da carteira");
    const started = events
      .map((e, i) => (e.type === "agent_started" ? { agent: e.agent, i } : undefined))
      .filter((x) => x !== undefined);
    const firstResult = events.findIndex((e) => e.type === "agent_result");
    const specialists = started.filter((x) => x.agent !== "navigator");
    expect(specialists.map((x) => x.agent).sort()).toEqual(["insight", "predictor", "risk"]);
    for (const x of specialists) expect(x.i).toBeLessThan(firstResult);

    const results = events.filter((e) => e.type === "agent_result");
    expect(
      results
        .map((e) => (e.type === "agent_result" ? e.agent : ""))
        .slice(0, 3)
        .sort(),
    ).toEqual(["insight", "predictor", "risk"]);
    expect(results.at(-1)).toMatchObject({ agent: "navigator" });

    const state = await asClient(() => svc.finalState(threadId));
    expect(Object.keys(state.results).sort()).toEqual(["insight", "predictor", "risk"]);
    expect(state.answer).toMatch(/^Resumo: /);
    expect(s.knowledge.search).toHaveBeenCalledTimes(1);
  });

  it("especialista risk falhando: errors.risk, agentFailure em results e síntese que avisa", async () => {
    s = setup({ risk: () => ({ nada: "a ver" }) });
    svc = s.make();
    const threadId = newThread();
    await turn(svc, threadId, "projeção e risco da carteira");
    const state = await asClient(() => svc.finalState(threadId));
    expect(state.errors["risk"]).toBeTruthy();
    expect(state.results["risk"]).toEqual(agentFailure());
    expect(state.results["insight"]).toBeTruthy();
    expect(state.answer).toContain("A análise de risk falhou");
    // log só com ids, sem o conteúdo
    const logged = s.logger.warn.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(logged.some((f) => f["agent"] === "risk" && f["threadId"] === threadId)).toBe(true);
    expect(JSON.stringify(logged)).not.toContain("projeção");
  });

  it("classificador lançando erro: o plano vem da heurística", async () => {
    s = setup({
      classifier: () => {
        throw new Error("provedor fora");
      },
    });
    svc = s.make();
    const q = "qual o risco da minha carteira?";
    const events = await turn(svc, newThread(), q);
    expect(events[0]).toEqual({ type: "plan", plan: heuristicPlan(q) });
  });

  it("classificador devolvendo lixo: heurística (saída do modelo não é confiável)", async () => {
    s = setup({ classifier: () => ({ complexity: "complexa", agents: ["root"] }) });
    svc = s.make();
    const events = await turn(svc, newThread(), "olá");
    expect(events[0]).toEqual({ type: "plan", plan: heuristicPlan("olá") });
  });

  it("thread com 30+ mensagens: cada agente recebe no máximo 20 de histórico", async () => {
    const threadId = newThread();
    for (let i = 0; i < 16; i++) await turn(svc, threadId, `olá ${i}`);
    const before = await asClient(() => svc.finalState(threadId));
    expect(before.messages.length).toBeGreaterThanOrEqual(30);

    const seen: { agent: string; history: number }[] = [];
    const wrap = (agent: string, target: { run(i: AgentInput): Promise<unknown> }) => {
      const orig = target.run.bind(target);
      vi.spyOn(target, "run").mockImplementation((input: AgentInput) => {
        seen.push({ agent, history: input.history.length });
        return orig(input);
      });
    };
    for (const a of ["insight", "risk", "predictor"] as const) wrap(a, s.agents.get(a));
    const nav = s.agents.navigator();
    const origSynth = nav.synthesize.bind(nav);
    vi.spyOn(nav, "synthesize").mockImplementation((input) => {
      seen.push({ agent: "navigator", history: input.history.length });
      return origSynth(input);
    });

    // E o que chega ao modelo: histórico (human/ai sem ids do CARINA) além do system prompt.
    const sizes: number[] = [];
    const inner = new MockResponderRegistry();
    registerAgentMockResponders(inner);
    const spyResp =
      (key: string): MockResponder =>
      (input) => {
        const history = input.messages.filter(
          (m: BaseMessage) => m.getType() !== "system" && !(m.id ?? "").startsWith("carina:"),
        );
        sizes.push(history.length);
        return inner.resolve(key)(input);
      };
    const s2 = setup({
      insight: spyResp("insight"),
      risk: spyResp("risk"),
      predictor: spyResp("predictor"),
      synthesize: spyResp("synthesize"),
    });
    const svc2 = s2.make();
    const thread2 = newThread();
    for (let i = 0; i < 16; i++) await turn(svc2, thread2, `olá ${i}`);
    await turn(svc2, thread2, "projeção e risco da carteira");
    expect(sizes).toHaveLength(4);
    for (const n of sizes) expect(n).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);

    await turn(svc, threadId, "projeção e risco da carteira");
    expect(seen).toHaveLength(4);
    for (const x of seen) expect(x.history).toBe(MAX_HISTORY_MESSAGES);
  });

  it("um turno novo zera results/errors do turno anterior", async () => {
    const threadId = newThread();
    await turn(svc, threadId, "projeção e risco da carteira");
    await turn(svc, threadId, "olá");
    const state = await asClient(() => svc.finalState(threadId));
    expect(state.results).toEqual({});
    expect(state.plan?.complexity).toBe("simples");
  });

  it("busca de conhecimento falhando: responde mesmo assim, com errors.retrieve", async () => {
    s.knowledge.search.mockRejectedValueOnce(new Error("db fora"));
    const threadId = newThread();
    const events = await turn(svc, threadId, "olá");
    expect(events.at(-1)).toMatchObject({ type: "agent_result", agent: "navigator" });
    const state = await asClient(() => svc.finalState(threadId));
    expect(state.errors["retrieve"]).toBeTruthy();
  });

  it("navigator falhando: resposta fixa de contingência, nunca derruba o grafo", async () => {
    s = setup({ navigator: () => "" });
    svc = s.make();
    const threadId = newThread();
    await turn(svc, threadId, "olá");
    const state = await asClient(() => svc.finalState(threadId));
    expect(state.errors["navigator"]).toBeTruthy();
    expect(state.answer).toMatch(/Não consegui/);
  });

  it("valida a pergunta e o thread antes de tocar no grafo", async () => {
    await expect(turn(svc, newThread(), "   ")).rejects.toThrow(ValidationError);
    await expect(turn(svc, newThread(), "x".repeat(8001))).rejects.toThrow(ValidationError);
    await expect(turn(svc, "sem-formato", "olá")).rejects.toThrow(ValidationError);
    await expect(collect(svc.stream({ threadId: newThread(), question: "olá" }))).rejects.toThrow();
    expect(s.knowledge.search).not.toHaveBeenCalled();
  });

  describe("execução", () => {
    it("irreversível: interrupt com approval_required e NADA executado", async () => {
      const threadId = newThread();
      const events = await turn(svc, threadId, "compre 100 ações de PETR4");
      expect(events.at(-1)).toEqual({
        type: "approval_required",
        approval: approvalView(APPROVAL),
      });
      expect(s.inbox.request).toHaveBeenCalledTimes(1);
      expect(s.inbox.request).toHaveBeenCalledWith({
        threadId,
        agent: "executor",
        action: "place_trade",
        payload: { side: "buy", assetCode: "PETR4", quantity: 100 },
        valueBrl: "3000.00",
      });
      expect(s.inbox.executeOnce).not.toHaveBeenCalled();
      expect(s.executed).not.toHaveBeenCalled();
      const state = await asClient(() => svc.finalState(threadId));
      expect(state.pending).toEqual({ approvalId: APPROVAL });
      expect(state.execution).toBeNull();
    });

    it("inbox.request roda com o TenantContext do thread (tenant e cliente)", async () => {
      let ctx: unknown;
      s.inbox.request.mockImplementationOnce(async () => {
        ctx = TenantContext.current();
        return { approvalId: APPROVAL, created: true };
      });
      await turn(svc, newThread(), "compre 100 ações de PETR4");
      expect(ctx).toMatchObject({ tenantId: T, clientId: C });
    });

    it("retomada aprovada executa uma vez; a segunda devolve o status gravado", async () => {
      const threadId = newThread();
      await turn(svc, threadId, "compre 100 ações de PETR4");
      s.db.status = "approved";
      const first = await asClient(() => svc.resume(threadId, true));
      expect(first.execution).toEqual({
        approvalId: APPROVAL,
        status: "succeeded",
        result: { orderId: "SIM-1" },
      });
      expect(s.inbox.executeOnce).toHaveBeenCalledTimes(1);
      expect(s.inbox.executeOnce).toHaveBeenCalledWith(APPROVAL);

      const again = await asClient(() => svc.resume(threadId, true));
      expect(again.execution).toEqual(first.execution);
      expect(s.inbox.executeOnce).toHaveBeenCalledTimes(1);
      // o executor (LLM) não roda de novo na retomada
      expect(s.inbox.request).toHaveBeenCalledTimes(1);
    });

    it("um OrchestratorService novo (mesmo checkpointer) retoma o thread", async () => {
      const threadId = newThread();
      await turn(svc, threadId, "compre 100 ações de PETR4");
      s.db.status = "approved";
      const fresh = s.make();
      const out = await asClient(() => fresh.resume(threadId, true));
      expect(out.execution?.status).toBe("succeeded");
      expect(s.inbox.executeOnce).toHaveBeenCalledTimes(1);
    });

    it("resume(true) cedo (banco pending): 409, interrupt preservado; depois da decisão executa uma vez", async () => {
      const threadId = newThread();
      await turn(svc, threadId, "compre 100 ações de PETR4");
      await expect(asClient(() => svc.resume(threadId, true))).rejects.toThrow(
        ApprovalConflictError,
      );
      expect(s.inbox.executeOnce).not.toHaveBeenCalled();
      s.db.status = "approved";
      const out = await asClient(() => svc.resume(threadId, true));
      expect(out.execution).toMatchObject({ approvalId: APPROVAL, status: "succeeded" });
      expect(s.executeCount()).toBe(1);
    });

    it("banco pending no nó (corrida com a checagem do service): erro repetível, thread retomável", async () => {
      const threadId = newThread();
      await turn(svc, threadId, "compre 100 ações de PETR4");
      // O service vê approved; o nó relê e vê pending (ex.: leitura anterior obsoleta).
      s.inbox.get
        .mockResolvedValueOnce({ ...approvalView(APPROVAL), status: "approved" })
        .mockResolvedValueOnce({ ...approvalView(APPROVAL), status: "pending" });
      await expect(asClient(() => svc.resume(threadId, true))).rejects.toThrow(
        ApprovalConflictError,
      );
      s.db.status = "approved";
      const out = await asClient(() => svc.resume(threadId, true));
      expect(out.execution?.status).toBe("succeeded");
      expect(s.executeCount()).toBe(1);
    });

    it("resume(false) com o banco approved: executa (o banco manda) e loga a divergência", async () => {
      const threadId = newThread();
      await turn(svc, threadId, "compre 100 ações de PETR4");
      s.db.status = "approved";
      const out = await asClient(() => svc.resume(threadId, false));
      expect(out.execution).toMatchObject({ approvalId: APPROVAL, status: "succeeded" });
      expect(s.executeCount()).toBe(1);
      const warned = s.logger.warn.mock.calls.map((c) => c[0] as Record<string, unknown>);
      expect(warned.some((f) => /diverge/.test(String(f["msg"])))).toBe(true);
    });

    it("resume(true) com o banco rejected ou expired: nunca executa", async () => {
      for (const status of ["rejected", "expired"] as const) {
        s = setup();
        svc = s.make();
        const threadId = newThread();
        await turn(svc, threadId, "compre 100 ações de PETR4");
        s.db.status = status;
        const out = await asClient(() => svc.resume(threadId, true));
        expect(out.execution).toEqual({ approvalId: APPROVAL, status: "rejected" });
        const later = await asClient(() => svc.resume(threadId, true));
        expect(later.execution.status).toBe("rejected");
        expect(s.inbox.executeOnce).not.toHaveBeenCalled();
      }
    });

    it("executeOnce skipped (outro worker executou): reporta o status real de executed_action", async () => {
      const threadId = newThread();
      await turn(svc, threadId, "compre 100 ações de PETR4");
      s.db.status = "approved";
      s.db.executed = { status: "started" };
      const out = await asClient(() => svc.resume(threadId, true));
      expect(out.execution).toEqual({ approvalId: APPROVAL, status: "started" });
      expect(s.inbox.executionOf).toHaveBeenCalledWith(APPROVAL);
    });

    it("falha transitória no executeOnce: o thread continua pendente e a retomada repete", async () => {
      const threadId = newThread();
      await turn(svc, threadId, "compre 100 ações de PETR4");
      s.db.status = "approved";
      s.inbox.executeOnce.mockRejectedValueOnce(new Error("db fora"));
      await expect(asClient(() => svc.resume(threadId, true))).rejects.toThrow("db fora");
      const out = await asClient(() => svc.resume(threadId, true));
      expect(out.execution?.status).toBe("succeeded");
      // O nó repetiu: a cerca do InboxService.executeOnce (testada no int) garante no máximo uma vez.
      expect(s.inbox.executeOnce).toHaveBeenCalledTimes(2);
      expect(s.executeCount()).toBe(1);
    });

    it("decisão que não é boolean é recusada antes do grafo", async () => {
      const threadId = newThread();
      await turn(svc, threadId, "compre 100 ações de PETR4");
      await expect(
        asClient(() => svc.resume(threadId, "true" as unknown as boolean)),
      ).rejects.toThrow(ValidationError);
      expect(s.inbox.executeOnce).not.toHaveBeenCalled();
    });

    it("outro tenant (ou outro cliente) não retoma, não lê e não continua o thread", async () => {
      const threadId = newThread();
      await turn(svc, threadId, "compre 100 ações de PETR4");
      for (const [t, c] of [
        [OTHER_T, OTHER_C],
        [OTHER_T, C],
        [T, OTHER_C],
      ] as const) {
        await expect(asClient(() => svc.resume(threadId, true), t, c)).rejects.toThrow(
          NotFoundError,
        );
        await expect(asClient(() => svc.finalState(threadId), t, c)).rejects.toThrow(NotFoundError);
        await expect(
          asClient(() => collect(svc.stream({ threadId, question: "olá" })), t, c),
        ).rejects.toThrow(NotFoundError);
      }
      await expect(
        TenantContext.run({ tenantId: T }, () => svc.resume(threadId, true)),
      ).rejects.toThrow(ValidationError);
      expect(s.inbox.executeOnce).not.toHaveBeenCalled();
    });

    it("thread aguardando aprovação recusa um turno novo (409)", async () => {
      const threadId = newThread();
      await turn(svc, threadId, "compre 100 ações de PETR4");
      await expect(turn(svc, threadId, "olá")).rejects.toThrow(ApprovalConflictError);
    });

    it("guard do stream: rejeitada com resume perdido fecha a espera (rejected) e segue o turno", async () => {
      const threadId = newThread();
      await turn(svc, threadId, "compre 100 ações de PETR4");
      s.db.status = "approved";
      await expect(turn(svc, threadId, "olá")).rejects.toThrow(/aprovada/);
      for (const status of ["rejected", "expired"] as const) {
        const other = newThread();
        await turn(svc, other, "compre 100 ações de PETR4");
        s.db.status = status;
        const events = await turn(svc, other, "olá");
        expect(events.some((e) => e.type === "approval_required")).toBe(false);
        s.db.status = "pending";
      }
      expect(s.inbox.executeOnce).not.toHaveBeenCalled();
      expect(s.logger.warn).toHaveBeenCalledWith({
        msg: expect.any(String),
        approvalId: APPROVAL,
        threadId: expect.any(String),
      });
    });

    it("retomar thread sem aprovação é NotFound", async () => {
      await expect(asClient(() => svc.resume(newThread(), true))).rejects.toThrow(NotFoundError);
    });

    it("leitura: executa direto, sem inbox", async () => {
      s = setup({
        executor: () => ({
          action: "get_positions",
          payload: {},
          valueBrl: "0.00",
          rationale: "leitura",
        }),
      });
      svc = s.make();
      const threadId = newThread();
      const events = await turn(svc, threadId, "transfira o relatório de posições");
      expect(s.executors.get).toHaveBeenCalledWith("get_positions");
      expect(s.executed).toHaveBeenCalledTimes(1);
      expect(s.inbox.request).not.toHaveBeenCalled();
      expect(types(events)).not.toContain("approval_required");
      const state = await asClient(() => svc.finalState(threadId));
      expect(state.results["executor"]).toMatchObject({ risk: "read", status: "succeeded" });
    });

    it("reversível: executa e publica notification, sem inbox", async () => {
      const threadId = newThread();
      await turn(svc, threadId, "aplicar um alerta para o dólar");
      expect(s.executors.get).toHaveBeenCalledWith("create_alert");
      expect(s.executed).toHaveBeenCalledTimes(1);
      expect(s.inbox.request).not.toHaveBeenCalled();
      expect(s.streams.publish).toHaveBeenCalledWith(
        "notifications",
        expect.objectContaining({ type: "notification", tenantId: T, clientId: C }),
      );
    });

    it("executor (LLM) falhando: agentFailure, nada pedido nem executado", async () => {
      s = setup({ executor: () => ({ action: "" }) });
      svc = s.make();
      const threadId = newThread();
      const events = await turn(svc, threadId, "compre 100 ações de PETR4");
      expect(types(events)).not.toContain("approval_required");
      const state = await asClient(() => svc.finalState(threadId));
      expect(state.results["executor"]).toEqual(agentFailure());
      expect(state.errors["executor"]).toBeTruthy();
      expect(s.inbox.request).not.toHaveBeenCalled();
      expect(s.executed).not.toHaveBeenCalled();
    });

    it("inbox.request falhando uma vez: nova tentativa idempotente e interrupt normal", async () => {
      s.inbox.request.mockRejectedValueOnce(new Error("timeout"));
      const threadId = newThread();
      const events = await turn(svc, threadId, "compre 100 ações de PETR4");
      expect(events.at(-1)?.type).toBe("approval_required");
      expect(s.inbox.request).toHaveBeenCalledTimes(2);
      expect(s.inbox.request.mock.calls[0]).toEqual(s.inbox.request.mock.calls[1]);
    });

    it("inbox.request com ValidationError não repete", async () => {
      s.inbox.request.mockRejectedValueOnce(new ValidationError("valor ruim"));
      const threadId = newThread();
      await turn(svc, threadId, "compre 100 ações de PETR4");
      expect(s.inbox.request).toHaveBeenCalledTimes(1);
      const state = await asClient(() => svc.finalState(threadId));
      expect(state.errors["executor"]).toBe("approval_request_failed");
    });

    it("inbox.request falhando duas vezes: sem interrupt, sem execução, erro registrado", async () => {
      s.inbox.request.mockRejectedValueOnce(new Error("db fora"));
      s.inbox.request.mockRejectedValueOnce(new Error("db fora"));
      const threadId = newThread();
      const events = await turn(svc, threadId, "compre 100 ações de PETR4");
      expect(types(events)).not.toContain("approval_required");
      const state = await asClient(() => svc.finalState(threadId));
      expect(state.pending).toBeNull();
      expect(state.errors["executor"]).toBe("approval_request_failed");
      expect(s.inbox.executeOnce).not.toHaveBeenCalled();
    });

    it("pedido sem verbo de execução nunca chega ao executor", async () => {
      s = setup({
        classifier: () => ({
          complexity: "média",
          agents: [],
          wantsExecution: true,
          rationale: "induzido",
        }),
      });
      svc = s.make();
      await turn(svc, newThread(), "como está o tempo?");
      expect(s.inbox.request).not.toHaveBeenCalled();
      expect(s.executed).not.toHaveBeenCalled();
    });
  });
});
