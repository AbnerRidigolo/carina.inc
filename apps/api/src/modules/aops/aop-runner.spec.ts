import type { Aop } from "@carina/shared";
import { describe, expect, it, vi } from "vitest";
import { TenantContext } from "../../core/context/tenant-context.js";
import { AllProvidersFailedError, QuotaExceededError } from "../../core/errors/domain-errors.js";
import { Prisma } from "../../generated/prisma/client.js";
import { buildMessages, MAX_OUTPUT_CHARS, QUESTION_MESSAGE_ID } from "../agents/agent.js";
import type { SearchResult } from "../knowledge/knowledge.service.js";
import { AopRunner, type AopLogger } from "./aop-runner.js";
import type { NewAopRun } from "./aops.repository.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const AOP_ID = "22222222-2222-4222-8222-222222222222";
const AUDIT_ID = "33333333-3333-4333-8333-333333333333";
const FIRE = new Date("2026-11-27T12:00:00.000Z");
const DESCRIPTION = "Toda sexta às 9h, analise a carteira e o risco dos clientes premium";

/** externalId → uuid interno dos clientes existentes. */
const CLIENTS: Record<string, string> = {
  c1: "44444444-4444-4444-8444-444444444444",
  c2: "55555555-5555-4555-8555-555555555555",
  c3: "66666666-6666-4666-8666-666666666666",
};

const KNOWLEDGE: SearchResult = {
  chunks: [{ documentId: "d", title: "Política", content: "conteúdo", score: 1 }],
  entities: [],
  neighbors: [],
} as unknown as SearchResult;

const aopOf = (over: Partial<Aop> = {}): Aop => ({
  id: AOP_ID,
  name: "Carteira premium",
  description: DESCRIPTION,
  agents: ["insight", "risk"],
  schedule: { frequency: "weekly", weekday: 4, day: 1, hour: 9 },
  clientIds: ["c1", "c2"],
  enabled: true,
  createdAt: "2026-11-01T12:00:00.000Z",
  lastFireAt: null,
  ...over,
});

type AgentImpl = (input: { question: string; history: unknown[]; knowledge: unknown }) => unknown;

interface SetupOpts {
  /** cota mensal do tenant (0 = ilimitada) */
  quota?: number;
  /** quantas reservas cabem antes de esgotar */
  room?: number;
  agents?: Record<string, AgentImpl>;
  clients?: Record<string, string>;
  billingFails?: boolean;
}

function setup(opts: SetupOpts = {}) {
  const clients = opts.clients ?? CLIENTS;
  const rows: NewAopRun[] = [];
  const contexts: { step: string; clientId: string | undefined }[] = [];
  const ctx = (step: string) => contexts.push({ step, clientId: TenantContext.current().clientId });

  const fakeTx = {
    tenant: {
      findUnique: vi.fn(() => Promise.resolve({ monthlyQuota: opts.quota ?? 100 })),
    },
    client: {
      findUnique: vi.fn(
        (args: { where: { tenantId_externalId: { tenantId: string; externalId: string } } }) => {
          const { tenantId, externalId } = args.where.tenantId_externalId;
          expect(tenantId).toBe(TENANT);
          const id = clients[externalId];
          return Promise.resolve(id === undefined ? null : { id });
        },
      ),
    },
    aopRun: {
      findFirst: vi.fn((args: { where: { aopId: string; clientId: string; fireAt: Date } }) => {
        const { aopId, clientId, fireAt } = args.where;
        const hit = rows.find(
          (r) =>
            r.aopId === aopId && r.clientId === clientId && r.fireAt.getTime() === fireAt.getTime(),
        );
        return Promise.resolve(hit ? { id: "x" } : null);
      }),
    },
  };
  const db = { tx: vi.fn(<T>(fn: (tx: unknown) => Promise<T>) => fn(fakeTx)) };
  const repo = {
    insertRun: vi.fn((tx: unknown, run: NewAopRun) => {
      expect(tx).toBe(fakeTx);
      ctx("insertRun");
      const dup = rows.some(
        (r) =>
          r.aopId === run.aopId &&
          r.clientId === run.clientId &&
          r.fireAt.getTime() === run.fireAt.getTime(),
      );
      if (dup) return Promise.resolve(null);
      rows.push(run);
      return Promise.resolve({ id: "run" });
    }),
  };
  const impls: Record<string, AgentImpl> = opts.agents ?? {
    insight: () => ({ summary: "ok" }),
    risk: () => ({ driftPct: 1 }),
  };
  const runs: { agent: string; input: Parameters<AgentImpl>[0] }[] = [];
  const agents = {
    get: vi.fn((name: string) => ({
      run: vi.fn(async (input: Parameters<AgentImpl>[0]) => {
        runs.push({ agent: name, input });
        ctx(`agent:${name}`);
        const impl = impls[name];
        if (!impl) throw new Error("agente sem fake");
        return impl(input);
      }),
    })),
  };
  const knowledge = {
    search: vi.fn((query: string) => {
      expect(query).toBe(DESCRIPTION);
      ctx("search");
      return Promise.resolve(KNOWLEDGE);
    }),
  };
  let used = 0;
  const quota = {
    reserve: vi.fn((t: { tenantId: string; monthlyQuota: number }) => {
      expect(t).toEqual({ tenantId: TENANT, monthlyQuota: opts.quota ?? 100 });
      ctx("reserve");
      if (opts.room !== undefined && used >= opts.room) {
        return Promise.reject(new QuotaExceededError("Cota mensal esgotada", 60));
      }
      used++;
      return Promise.resolve();
    }),
    refund: vi.fn(() => {
      used--;
      return Promise.resolve();
    }),
  };
  const billing = {
    record: vi.fn((input: { tx?: unknown; workType: string }) => {
      expect(input.tx).toBe(fakeTx);
      ctx("billing");
      if (opts.billingFails) return Promise.reject(new Error("banco fora"));
      return Promise.resolve({
        priceBrl: new Prisma.Decimal(input.workType === "multi_agent_analysis" ? "15" : "7.5"),
      });
    }),
  };
  const watchtower = {
    review: vi.fn((input: { tx?: unknown }) => {
      expect(input.tx).toBe(fakeTx);
      ctx("review");
      return Promise.resolve({ auditId: AUDIT_ID, flags: [] });
    }),
  };
  const logger: AopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let now = Date.parse("2026-11-27T12:05:00.000Z");
  const clock = () => (now += 250);
  const runner = new AopRunner(
    db as never,
    repo as never,
    agents as never,
    knowledge as never,
    quota as never,
    billing as never,
    watchtower as never,
    clock,
    logger,
  );
  const run = (aop: Aop = aopOf(), trigger: "schedule" | "manual" = "schedule", fireAt = FIRE) =>
    TenantContext.run({ tenantId: TENANT }, () => runner.run(aop, { fireAt, trigger }));
  return {
    run,
    rows,
    runs,
    contexts,
    db,
    repo,
    agents,
    knowledge,
    quota,
    billing,
    watchtower,
    logger,
  };
}

const allLogs = (logger: AopLogger) =>
  JSON.stringify([
    vi.mocked(logger.info).mock.calls,
    vi.mocked(logger.warn).mock.calls,
    vi.mocked(logger.error).mock.calls,
  ]);

describe("AopRunner.run", () => {
  it("roda os agentes, cobra classifyWork e audita por cliente", async () => {
    const s = setup();
    const summary = await s.run();

    expect(summary).toEqual({
      ok: 2,
      failed: 0,
      skipped: 0,
      alreadyRan: 0,
      errors: 0,
      clients: [
        { clientId: "c1", status: "ok", failureCode: null },
        { clientId: "c2", status: "ok", failureCode: null },
      ],
    });
    expect(s.rows).toEqual([
      expect.objectContaining({
        aopId: AOP_ID,
        clientId: CLIENTS["c1"],
        fireAt: FIRE,
        trigger: "schedule",
        status: "ok",
        failureCode: null,
        results: { insight: { summary: "ok" }, risk: { driftPct: 1 } },
        workType: "multi_agent_analysis",
        priceBrl: "15.00",
        auditId: AUDIT_ID,
      }),
      expect.objectContaining({ clientId: CLIENTS["c2"], status: "ok", priceBrl: "15.00" }),
    ]);
    // cobrança com o uuid INTERNO e os agentes do AOP
    expect(s.billing.record).toHaveBeenCalledTimes(2);
    expect(s.billing.record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        clientId: CLIENTS["c1"],
        workType: "multi_agent_analysis",
        agents: ["insight", "risk"],
        durationMs: expect.any(Number) as number,
      }),
    );
    expect(s.billing.record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ clientId: CLIENTS["c2"] }),
    );
    // Watchtower: canal worker, query marcada com o nome, resposta = resultados serializados
    expect(s.watchtower.review).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        clientId: CLIENTS["c1"],
        channel: "worker",
        query: `[AOP:Carteira premium] ${DESCRIPTION}`,
        agents: ["insight", "risk"],
        responseText: JSON.stringify({ insight: { summary: "ok" }, risk: { driftPct: 1 } }),
      }),
    );
    expect(s.quota.reserve).toHaveBeenCalledTimes(2);
    expect(s.quota.refund).not.toHaveBeenCalled();
    // busca, agentes, cota e gravação sob o cliente fixado
    for (const c of s.contexts) expect(c.clientId).toMatch(/^[45]{8}-/);
    // logs só com ids e contagens: nem descrição nem nome do AOP nem externalId
    const logs = allLogs(s.logger);
    expect(logs).not.toContain("analise a carteira");
    expect(logs).not.toContain("Carteira premium");
    expect(logs).not.toContain('"c1"');
  });

  it("pergunta aos agentes contém a descrição como dado (mensagem human isolada, nunca no system)", async () => {
    const s = setup();
    await s.run(aopOf({ clientIds: ["c1"] }));

    expect(s.runs.map((r) => r.agent)).toEqual(["insight", "risk"]);
    for (const { input } of s.runs) {
      expect(input.question).toBe(`Execute o procedimento: ${DESCRIPTION}`);
      expect(input.history).toEqual([]);
      expect(input.knowledge).toBe(KNOWLEDGE);
    }
    const first = s.runs[0];
    if (!first) throw new Error("sem execução");
    const messages = buildMessages("PROMPT FIXO", { ...first.input, history: [] } as never);
    expect(messages[0]?.content).toBe("PROMPT FIXO");
    const last = messages.at(-1);
    expect(last?.id).toBe(QUESTION_MESSAGE_ID);
    expect(last?.content).toBe(`Execute o procedimento: ${DESCRIPTION}`);
  });

  it("um agente falha → {failed:true}, os outros contam (ok, cobrado)", async () => {
    const s = setup({
      agents: {
        insight: () => ({ summary: "ok" }),
        risk: () => {
          throw new AllProvidersFailedError();
        },
      },
    });
    const summary = await s.run(aopOf({ clientIds: ["c1"] }));

    expect(summary.ok).toBe(1);
    expect(s.rows[0]).toMatchObject({
      status: "ok",
      failureCode: null,
      results: { insight: { summary: "ok" }, risk: { failed: true } },
      workType: "multi_agent_analysis",
    });
    expect(s.billing.record).toHaveBeenCalledTimes(1);
    expect(s.quota.refund).not.toHaveBeenCalled();
  });

  it("todos falham → failed/agents_failed, cota estornada, sem cobrança", async () => {
    const boom = () => {
      throw new AllProvidersFailedError();
    };
    const s = setup({ agents: { insight: boom, risk: boom } });
    const summary = await s.run(aopOf({ clientIds: ["c1"] }));

    expect(summary).toMatchObject({ ok: 0, failed: 1, skipped: 0 });
    expect(s.rows).toEqual([
      expect.objectContaining({
        status: "failed",
        failureCode: "agents_failed",
        results: { insight: { failed: true }, risk: { failed: true } },
        workType: null,
        priceBrl: null,
        auditId: null,
      }),
    ]);
    expect(s.quota.reserve).toHaveBeenCalledTimes(1);
    expect(s.quota.refund).toHaveBeenCalledTimes(1);
    expect(s.billing.record).not.toHaveBeenCalled();
    expect(s.watchtower.review).not.toHaveBeenCalled();
  });

  it("cota esgotada no meio → skipped/quota_exceeded deste e dos seguintes, sem cobrança (RF 4)", async () => {
    const s = setup({ quota: 10, room: 1 });
    const summary = await s.run(aopOf({ clientIds: ["c1", "c2", "c3"] }));

    expect(summary).toMatchObject({ ok: 1, failed: 0, skipped: 2, errors: 0 });
    expect(
      s.rows.map((r) => [r.clientId, r.status, r.failureCode, r.workType, r.priceBrl]),
    ).toEqual([
      [CLIENTS["c1"], "ok", null, "multi_agent_analysis", "15.00"],
      [CLIENTS["c2"], "skipped", "quota_exceeded", null, null],
      [CLIENTS["c3"], "skipped", "quota_exceeded", null, null],
    ]);
    // c3 nem tenta reservar; só c1 roda agentes e é cobrado
    expect(s.quota.reserve).toHaveBeenCalledTimes(2);
    expect(s.runs.every((r) => r.input.question.length > 0)).toBe(true);
    expect(s.runs).toHaveLength(2);
    expect(s.billing.record).toHaveBeenCalledTimes(1);
    expect(s.quota.refund).not.toHaveBeenCalled();
  });

  it("cliente removido → skipped/client_not_found, sem cota nem cobrança; os outros rodam (RF 5)", async () => {
    const s = setup({ clients: { c1: CLIENTS["c1"] ?? "", c3: CLIENTS["c3"] ?? "" } });
    const summary = await s.run(aopOf({ clientIds: ["c1", "c2", "c3"] }));

    expect(summary).toMatchObject({ ok: 2, skipped: 1, failed: 0 });
    expect(summary.clients).toEqual([
      { clientId: "c1", status: "ok", failureCode: null },
      { clientId: "c2", status: "skipped", failureCode: "client_not_found" },
      { clientId: "c3", status: "ok", failureCode: null },
    ]);
    // aop_run.client_id é FK para client: sem cliente não há linha (só o resumo e o log)
    expect(s.rows.map((r) => r.clientId)).toEqual([CLIENTS["c1"], CLIENTS["c3"]]);
    expect(s.quota.reserve).toHaveBeenCalledTimes(2);
    expect(s.billing.record).toHaveBeenCalledTimes(2);
  });

  it("mesmo AOP e fireAt de novo (reentrega) → não roda agentes, não reserva nem cobra", async () => {
    const s = setup();
    await s.run(aopOf(), "manual");
    const runs = s.runs.length;
    const summary = await s.run(aopOf(), "manual");

    expect(summary).toMatchObject({ ok: 0, alreadyRan: 2 });
    expect(s.runs).toHaveLength(runs);
    expect(s.quota.reserve).toHaveBeenCalledTimes(2);
    expect(s.billing.record).toHaveBeenCalledTimes(2);
    expect(s.rows).toHaveLength(2);
    expect(s.rows.every((r) => r.trigger === "manual")).toBe(true);
  });

  it("corrida: a execução já gravada por outro worker desfaz a cobrança e devolve a cota", async () => {
    const s = setup();
    // outro worker grava o c1 entre a checagem e a gravação deste
    s.repo.insertRun.mockImplementationOnce(() => Promise.resolve(null));
    const summary = await s.run(aopOf({ clientIds: ["c1"] }));

    expect(summary).toMatchObject({ ok: 0, alreadyRan: 1, errors: 0 });
    expect(s.quota.refund).toHaveBeenCalledTimes(1);
    // a cobrança foi feita dentro da tx, que é desfeita: o `tx` lançou
    const result = await s.db.tx.mock.results[s.db.tx.mock.results.length - 1]?.value.catch(
      (e: unknown) => e,
    );
    expect(result).toBeInstanceOf(Error);
  });

  it("falha na cobrança de um cliente → cota devolvida, sem linha, os outros seguem", async () => {
    const s = setup({ billingFails: true });
    const summary = await s.run();

    expect(summary).toMatchObject({ ok: 0, errors: 2 });
    expect(s.rows).toEqual([]);
    expect(s.quota.refund).toHaveBeenCalledTimes(2);
    expect(allLogs(s.logger)).not.toContain("banco fora");
  });

  it("resultado em texto é cortado em MAX_OUTPUT_CHARS; resultado não serializável vira falha", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const s = setup({
      agents: { insight: () => "x".repeat(MAX_OUTPUT_CHARS + 50), risk: () => cyclic },
    });
    await s.run(aopOf({ clientIds: ["c1"] }));

    const results = s.rows[0]?.results as Record<string, unknown>;
    expect((results["insight"] as string).length).toBe(MAX_OUTPUT_CHARS);
    expect(results["risk"]).toEqual({ failed: true });
  });

  it("busca de conhecimento que falha → conhecimento vazio, agentes rodam", async () => {
    const s = setup();
    s.knowledge.search.mockRejectedValueOnce(new Error("pgvector fora"));
    const summary = await s.run(aopOf({ clientIds: ["c1"] }));

    expect(summary.ok).toBe(1);
    expect(s.runs[0]?.input.knowledge).toEqual({ chunks: [], entities: [], neighbors: [] });
  });

  it("usa no máximo AOP_MAX_CLIENTS clientes", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `k${String(i)}`,
        `77777777-7777-4777-8777-${String(i).padStart(12, "0")}`,
      ]),
    );
    const s = setup({ clients: many });
    const summary = await s.run(aopOf({ clientIds: Object.keys(many) }));
    expect(summary.ok).toBe(20);
  });
});
