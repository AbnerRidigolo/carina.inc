/**
 * Orquestrador com Nest, Postgres (PostgresSaver no schema `langgraph`, como carina_app) e Redis
 * reais, em LLM_MODE=mock: interrupt durável, retomada em outra instância (restart), execução no
 * máximo uma vez, rejeição e isolamento de threads entre tenants. Com MARKET_MODE=mock (padrão
 * fora de produção), o `place_trade` usa o preço de servidor (PETR4 a R$ 30,00, spec 5.5).
 */
import { randomUUID } from "node:crypto";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { ChatEvent } from "@carina/shared";
import type { Redis } from "ioredis";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import { ApprovalConflictError, NotFoundError } from "../../src/core/errors/domain-errors.js";
import { REDIS } from "../../src/core/redis/redis.module.js";
import { agentFailure } from "../../src/modules/agents/agent.js";
import { ExecutorRegistry } from "../../src/modules/inbox/executors.js";
import { InboxService } from "../../src/modules/inbox/inbox.service.js";
import { type MockResponder, MockResponderRegistry } from "../../src/modules/llm/mock-models.js";
import { MarketPriceError } from "../../src/modules/market/market-price-error.js";
import { MarketService } from "../../src/modules/market/market.service.js";
import {
  CHECKPOINT_MIGRATION_VERSION,
  CHECKPOINT_SCHEMA,
} from "../../src/modules/orchestrator/checkpointer.js";
import type { OrchestratorGraph } from "../../src/modules/orchestrator/graph.js";
import { OrchestratorModule } from "../../src/modules/orchestrator/orchestrator.module.js";
import { OrchestratorService } from "../../src/modules/orchestrator/orchestrator.service.js";
import { createTestApp, type TestApp } from "../setup/app.js";
import { appUrl, migratorSql, migratorUrl, must, withPgClient } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

const REDIS_DB = redisDbOf("orchestrator/orchestrator.int.spec.ts");

/**
 * Registro de mocks com o responder do executor trocável por teste (sem mudar os padrões): sem
 * troca, vale o responder padrão dos agentes.
 */
class SwitchableMockRegistry extends MockResponderRegistry {
  executor: MockResponder | undefined;

  override resolve(mockKey: string): MockResponder {
    if (mockKey === "executor" && this.executor) return this.executor;
    return super.resolve(mockKey);
  }
}

interface Party {
  tenantId: string;
  clientId: string;
  by: Parameters<InboxService["decide"]>[2];
}

describe("Orquestrador (int)", () => {
  let t1: TestApp;
  let t2: TestApp;
  let redis: Redis;
  let A: Party;
  let B: Party;
  const placeTrade = vi.fn(async () => ({ orderId: "SIM-INT", status: "filled" }));
  const mocks = new SwitchableMockRegistry();

  async function party(t: TestApp, name: string): Promise<Party> {
    const seeded = await t.seedTenant({ name });
    const [c] = await migratorSql<{ id: string }>(
      `INSERT INTO client (tenant_id, external_id) VALUES ($1, 'cli-1') RETURNING id`,
      [seeded.tenantId],
      { tenantId: seeded.tenantId },
    );
    const [k] = await migratorSql<{ id: string }>(
      `SELECT id FROM api_key WHERE tenant_id = $1 AND label = 'approver'`,
      [seeded.tenantId],
    );
    return {
      tenantId: seeded.tenantId,
      clientId: must(c).id,
      by: {
        keyId: must(k).id,
        tenantId: seeded.tenantId,
        tenantName: name,
        scopes: ["chat", "inbox:decide"],
        rpm: 1000,
        monthlyQuota: 0,
      },
    };
  }

  const as = <R>(p: Party, fn: () => Promise<R>) =>
    TenantContext.run({ tenantId: p.tenantId, clientId: p.clientId }, fn);
  const thread = (p: Party) => `${p.tenantId}:${p.clientId}:${randomUUID()}`;
  const svc = (t: TestApp) => t.app.get(OrchestratorService);

  async function turn(t: TestApp, p: Party, threadId: string, question: string) {
    const events: ChatEvent[] = [];
    await as(p, async () => {
      for await (const e of svc(t).stream({ threadId, question })) events.push(e);
    });
    return events;
  }

  const decide = (t: TestApp, p: Party, id: string, approved: boolean) =>
    TenantContext.run({ tenantId: p.tenantId }, () =>
      t.app.get(InboxService).decide(id, { approved }, p.by),
    );

  const approvals = (p: Party) =>
    migratorSql<{ id: string; status: string; thread_id: string }>(
      `SELECT id, status, thread_id FROM approval_request`,
      [],
      { tenantId: p.tenantId },
    );
  const executions = (p: Party, approvalId: string) =>
    migratorSql<{ status: string }>(
      `SELECT status FROM executed_action WHERE approval_request_id = $1`,
      [approvalId],
      { tenantId: p.tenantId },
    );

  beforeAll(async () => {
    t1 = await createTestApp({
      imports: [OrchestratorModule],
      redisDb: REDIS_DB,
      overrides: [{ token: MockResponderRegistry, useValue: mocks }],
    });
    redis = t1.app.get<Redis>(REDIS);
    A = await party(t1, "Orq A");
    B = await party(t1, "Orq B");
  });

  afterAll(async () => {
    await t2?.close();
    await t1?.close();
  });

  beforeEach(async () => {
    await redis.flushdb();
    placeTrade.mockClear();
    mocks.executor = undefined;
    vi.restoreAllMocks();
    for (const t of [t1, t2]) {
      if (!t) continue;
      const reg = t.app.get(ExecutorRegistry);
      reg.resetDefaults();
      reg.register("place_trade", placeTrade);
    }
  });

  it("compra: approval_required, pendente, nada executado; restart retoma uma vez só", async () => {
    const threadId = thread(A);
    const events = await turn(t1, A, threadId, "compre 100 ações de PETR4");
    const last = events.at(-1);
    expect(last?.type).toBe("approval_required");
    const approvalId = last?.type === "approval_required" ? last.approval.id : "";

    const rows = await approvals(A);
    expect(rows).toEqual([{ id: approvalId, status: "pending", thread_id: threadId }]);
    expect(placeTrade).not.toHaveBeenCalled();
    expect(await executions(A, approvalId)).toHaveLength(0);

    // Checkpoint persistido no Postgres, com o thread prefixado pelo tenant e cliente.
    const cps = await migratorSql<{ n: string }>(
      `SELECT count(*)::text AS n FROM langgraph.checkpoints WHERE thread_id = $1`,
      [threadId],
    );
    expect(Number(must(cps[0]).n)).toBeGreaterThan(0);

    await decide(t1, A, approvalId, true);

    // "Restart": outra instância do app (outro OrchestratorService e outro pool) retoma.
    t2 = await createTestApp({ imports: [OrchestratorModule], redisDb: REDIS_DB });
    t2.app.get(ExecutorRegistry).register("place_trade", placeTrade);
    expect(svc(t2)).not.toBe(svc(t1));

    const out = await as(A, () => svc(t2).resume(threadId, true));
    expect(out.execution).toEqual({
      approvalId,
      status: "succeeded",
      result: { orderId: "SIM-INT", status: "filled" },
    });
    expect(placeTrade).toHaveBeenCalledTimes(1);

    const again = await as(A, () => svc(t1).resume(threadId, true));
    // Thread já resolvido: devolve a execução gravada (status real), sem chamar o executor.
    expect(again.execution).toEqual(out.execution);
    expect(placeTrade).toHaveBeenCalledTimes(1);
    expect(await executions(A, approvalId)).toEqual([{ status: "succeeded" }]);

    const state = await as(A, () => svc(t1).finalState(threadId));
    expect(state.execution?.status).toBe("succeeded");
  });

  it("retomadas concorrentes (duas instâncias): executa uma vez e ninguém reporta skipped", async () => {
    t2 ??= await createTestApp({ imports: [OrchestratorModule], redisDb: REDIS_DB });
    t2.app.get(ExecutorRegistry).register("place_trade", placeTrade);
    const threadId = thread(A);
    const events = await turn(t1, A, threadId, "compre 7 ações de VALE3");
    const last = events.at(-1);
    const approvalId = last?.type === "approval_required" ? last.approval.id : "";
    await decide(t1, A, approvalId, true);

    const results = await Promise.allSettled([
      as(A, () => svc(t1).resume(threadId, true)),
      as(A, () => svc(t2).resume(threadId, true)),
    ]);
    expect(placeTrade).toHaveBeenCalledTimes(1);
    const statuses = results.flatMap((r) =>
      r.status === "fulfilled" ? [r.value.execution.status] : [],
    );
    expect(statuses).toContain("succeeded");
    // O perdedor lê executed_action: succeeded (ou started, se o vencedor ainda estava rodando).
    for (const st of statuses) expect(["succeeded", "started"]).toContain(st);
    expect(await executions(A, approvalId)).toEqual([{ status: "succeeded" }]);
  });

  it("rejeitada: a retomada nunca executa", async () => {
    const threadId = thread(A);
    const events = await turn(t1, A, threadId, "compre 3 ações de ITUB4");
    const last = events.at(-1);
    const approvalId = last?.type === "approval_required" ? last.approval.id : "";
    await decide(t1, A, approvalId, false);

    const out = await as(A, () => svc(t1).resume(threadId, false));
    expect(out.execution).toEqual({ approvalId, status: "rejected" });
    // Mesmo uma retomada "aprovada" forjada depois não executa (thread já resolvido).
    const forged = await as(A, () => svc(t1).resume(threadId, true));
    expect(forged.execution.status).toBe("rejected");
    expect(placeTrade).not.toHaveBeenCalled();
    expect(await executions(A, approvalId)).toHaveLength(0);
  });

  it("resume(true) cedo (banco pending): 409 e nada executa; após a decisão executa uma vez", async () => {
    const threadId = thread(B);
    const events = await turn(t1, B, threadId, "compre 5 ações de BBAS3");
    const last = events.at(-1);
    const approvalId = last?.type === "approval_required" ? last.approval.id : "";
    await expect(as(B, () => svc(t1).resume(threadId, true))).rejects.toThrow(
      ApprovalConflictError,
    );
    expect(placeTrade).not.toHaveBeenCalled();
    expect(await executions(B, approvalId)).toHaveLength(0);
    expect((await approvals(B)).find((r) => r.id === approvalId)?.status).toBe("pending");

    await decide(t1, B, approvalId, true);
    const out = await as(B, () => svc(t1).resume(threadId, true));
    expect(out.execution).toMatchObject({ approvalId, status: "succeeded" });
    const again = await as(B, () => svc(t1).resume(threadId, true));
    expect(again.execution.status).toBe("succeeded");
    expect(placeTrade).toHaveBeenCalledTimes(1);
    expect(await executions(B, approvalId)).toEqual([{ status: "succeeded" }]);
  });

  it("resume(false) com o banco approved: executa (o banco manda)", async () => {
    const threadId = thread(B);
    const events = await turn(t1, B, threadId, "compre 4 ações de BBDC4");
    const last = events.at(-1);
    const approvalId = last?.type === "approval_required" ? last.approval.id : "";
    await decide(t1, B, approvalId, true);
    const out = await as(B, () => svc(t1).resume(threadId, false));
    expect(out.execution).toMatchObject({ approvalId, status: "succeeded" });
    expect(placeTrade).toHaveBeenCalledTimes(1);
  });

  it("resume(true) com o banco rejected: não executa", async () => {
    const threadId = thread(B);
    const events = await turn(t1, B, threadId, "compre 2 ações de MGLU3");
    const last = events.at(-1);
    const approvalId = last?.type === "approval_required" ? last.approval.id : "";
    await decide(t1, B, approvalId, false);
    const out = await as(B, () => svc(t1).resume(threadId, true));
    expect(out.execution).toEqual({ approvalId, status: "rejected" });
    expect(placeTrade).not.toHaveBeenCalled();
    expect(await executions(B, approvalId)).toHaveLength(0);
  });

  describe("a mesma ordem repetida no mesmo thread (um pedido novo por turno)", () => {
    const BUY = "compre 100 ações de PETR4";
    const approvalOf = (events: ChatEvent[]) => {
      const last = events.at(-1);
      if (last?.type !== "approval_required") throw new Error("esperava approval_required");
      return last.approval;
    };

    it("depois de aprovada e executada: a 2ª cria OUTRA aprovação pendente e só executa depois da decisão", async () => {
      const threadId = thread(A);
      const first = approvalOf(await turn(t1, A, threadId, BUY));
      await decide(t1, A, first.id, true);
      await as(A, () => svc(t1).resume(threadId, true));
      expect(placeTrade).toHaveBeenCalledTimes(1);

      const second = approvalOf(await turn(t1, A, threadId, BUY));
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe("pending");
      expect(placeTrade).toHaveBeenCalledTimes(1);
      const pending = await as(A, () => t1.app.get(InboxService).listPending("cli-1"));
      expect(pending.map((a) => a.id)).toContain(second.id);

      await decide(t1, A, second.id, true);
      const out = await as(A, () => svc(t1).resume(threadId, true));
      expect(out.execution).toMatchObject({ approvalId: second.id, status: "succeeded" });
      expect(placeTrade).toHaveBeenCalledTimes(2);
      expect(await executions(A, first.id)).toEqual([{ status: "succeeded" }]);
      expect(await executions(A, second.id)).toEqual([{ status: "succeeded" }]);
      // O thread não fica preso: um turno comum passa.
      expect((await turn(t1, A, threadId, "como está minha carteira?")).length).toBeGreaterThan(0);
    });

    it("depois de rejeitada: a 2ª é um pedido novo pendente, nunca fechado sem decisão humana", async () => {
      const threadId = thread(A);
      const first = approvalOf(await turn(t1, A, threadId, BUY));
      await decide(t1, A, first.id, false);
      await as(A, () => svc(t1).resume(threadId, false));

      const second = approvalOf(await turn(t1, A, threadId, BUY));
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe("pending");
      // O próximo turno não fecha a 2ª como rejeitada: ela segue pendente (409 até a decisão).
      await expect(turn(t1, A, threadId, "olá")).rejects.toThrow(/ainda não foi decidida/);
      const rows = await approvals(A);
      expect(rows.find((r) => r.id === second.id)?.status).toBe("pending");
      expect(rows.find((r) => r.id === first.id)?.status).toBe("rejected");
      expect(placeTrade).not.toHaveBeenCalled();
    });

    it("idempotência dentro do turno: o pedido repetido no MESMO turno devolve o mesmo id", async () => {
      const inbox = t1.app.get(InboxService);
      const threadId = thread(A);
      const input = {
        threadId,
        turn: 3,
        agent: "executor",
        action: "place_trade",
        payload: { side: "buy", assetCode: "PETR4", quantity: 100 },
        valueBrl: "3000.00",
      };
      const a = await as(A, () => inbox.request(input));
      const b = await as(A, () => inbox.request(input));
      expect(a).toEqual({ approvalId: a.approvalId, created: true });
      expect(b).toEqual({ approvalId: a.approvalId, created: false });
      const c = await as(A, () => inbox.request({ ...input, turn: 4 }));
      expect(c.created).toBe(true);
      expect(c.approvalId).not.toBe(a.approvalId);
    });
  });

  describe("preço de servidor no place_trade (spec 5.5)", () => {
    const rowsOf = (p: Party, threadId: string) =>
      migratorSql<{ id: string; status: string; payload: Record<string, unknown>; value: string }>(
        `SELECT id, status, payload, value_brl::text AS value FROM approval_request
          WHERE thread_id = $1`,
        [threadId],
        { tenantId: p.tenantId },
      );
    /** Cobranças de execução do tenant (cada teste que executa usa um tenant novo). */
    const executionUsage = (p: Party) =>
      migratorSql<{ price: string; fee: string; value: string }>(
        `SELECT price_brl::text AS price, fee_brl::text AS fee, value_brl::text AS value
           FROM usage_record WHERE work_type = 'execution'`,
        [],
        { tenantId: p.tenantId },
      );
    const approvalOf = (events: ChatEvent[]) => {
      const last = events.at(-1);
      if (last?.type !== "approval_required") throw new Error("esperava approval_required");
      return last.approval;
    };
    const MODEL_PAYLOAD = {
      side: "buy",
      assetCode: "PETR4",
      quantity: 100,
      unitPriceBrl: "0.01",
      Price: "0.01",
      AMOUNT: "1.00",
      valueBrl: "1.00",
      foo: "bar",
    };
    const PRICED_KEYS = [
      "assetCode",
      "marketState",
      "notionalBrl",
      "priceAsOf",
      "priceSource",
      "quantity",
      "side",
      "unitPriceBrl",
    ];

    it("R-M7: modelo com valueBrl incoerente e preço próprio → aprovação com o valor do servidor; a execução cobra R$ 90,00", async () => {
      const P = await party(t1, `Preço ${randomUUID()}`);
      mocks.executor = () => ({
        action: "place_trade",
        payload: { ...MODEL_PAYLOAD },
        valueBrl: "1.00",
        rationale: "modelo com valor e preço próprios",
      });
      const threadId = thread(P);
      const approval = approvalOf(await turn(t1, P, threadId, "compre 100 ações de PETR4"));
      expect(approval.valueBrl).toBe("3000.00");

      const rows = await rowsOf(P, threadId);
      expect(rows).toHaveLength(1);
      const row = must(rows[0]);
      expect(row.id).toBe(approval.id);
      expect(row.value).toBe("3000.00");
      expect(Object.keys(row.payload).sort()).toEqual(PRICED_KEYS);
      expect(row.payload).toMatchObject({
        side: "buy",
        assetCode: "PETR4",
        quantity: 100,
        unitPriceBrl: "30.00",
        notionalBrl: "3000.00",
        priceSource: "mock",
        marketState: "open",
      });
      expect(typeof row.payload["priceAsOf"]).toBe("string");
      for (const k of ["Price", "AMOUNT", "foo", "valueBrl"])
        expect(row.payload).not.toHaveProperty(k);

      // O resumo do executor no estado também mostra o valor do servidor.
      const state = await as(P, () => svc(t1).finalState(threadId));
      expect(state.results["executor"]).toMatchObject({
        valueBrl: "3000.00",
        payload: row.payload,
      });

      await decide(t1, P, approval.id, true);
      const out = await as(P, () => svc(t1).resume(threadId, true));
      expect(out.execution).toMatchObject({ approvalId: approval.id, status: "succeeded" });
      expect(placeTrade).toHaveBeenCalledTimes(1);
      expect(placeTrade).toHaveBeenCalledWith(
        row.payload,
        expect.objectContaining({ approvalId: approval.id }),
      );
      // 90,00 = 75,00 + 0,5% de 3.000,00 (o valor do servidor, nunca o 1,00 do modelo).
      expect(await executionUsage(P)).toEqual([{ price: "90.00", fee: "15.00", value: "3000.00" }]);
    });

    it("ordem padrão de PETR4: aprovação de R$ 3.000,00 com o payload enriquecido", async () => {
      const threadId = thread(A);
      const approval = approvalOf(await turn(t1, A, threadId, "compre 100 ações de PETR4"));
      expect(approval).toMatchObject({
        valueBrl: "3000.00",
        payload: {
          side: "buy",
          assetCode: "PETR4",
          quantity: 100,
          unitPriceBrl: "30.00",
          notionalBrl: "3000.00",
          priceSource: "mock",
          marketState: "open",
        },
      });
    });

    it.each([
      ["price_unavailable", () => new MarketPriceError("price_unavailable"), "price_unavailable"],
      ["price_stale", () => new MarketPriceError("price_stale"), "price_stale"],
      ["erro inesperado", () => new Error("redis fora"), "price_unavailable"],
    ] as const)(
      "cotação falhando (%s): nenhuma aprovação e a falha do executor com o código",
      async (_n, err, code) => {
        vi.spyOn(t1.app.get(MarketService), "priceFor").mockRejectedValueOnce(err());
        const threadId = thread(A);
        const events = await turn(t1, A, threadId, "compre 100 ações de PETR4");
        expect(events.some((e) => e.type === "approval_required")).toBe(false);
        expect(await rowsOf(A, threadId)).toEqual([]);
        const state = await as(A, () => svc(t1).finalState(threadId));
        expect(state.pending).toBeNull();
        expect(state.errors["executor"]).toBe(code);
        expect(state.results["executor"]).toMatchObject({ ...agentFailure(), reason: code });
        expect(placeTrade).not.toHaveBeenCalled();
      },
    );

    it("ativo desconhecido do provedor (ABEV3 fora da tabela do mock): unknown_asset, sem aprovação", async () => {
      const threadId = thread(A);
      const events = await turn(t1, A, threadId, "compre 4 ações de ABEV3");
      expect(events.some((e) => e.type === "approval_required")).toBe(false);
      expect(await rowsOf(A, threadId)).toEqual([]);
      const state = await as(A, () => svc(t1).finalState(threadId));
      expect(state.errors["executor"]).toBe("unknown_asset");
      expect(state.pending).toBeNull();
    });

    it("reexecução do nó executor no mesmo turno com o provedor caído: a aprovação do 1º passe, uma linha só, sem nova cotação", async () => {
      const P = await party(t1, `Preço ${randomUUID()}`);
      const priceFor = vi.spyOn(t1.app.get(MarketService), "priceFor");
      const threadId = thread(P);
      const approval = approvalOf(await turn(t1, P, threadId, "compre 100 ações de PETR4"));
      expect(priceFor).toHaveBeenCalledTimes(1);
      const before = await rowsOf(P, threadId);
      expect(before).toHaveLength(1);

      // O provedor cai; o nó executor do MESMO turno roda de novo (volta ao checkpoint de antes dele).
      priceFor.mockRejectedValue(new MarketPriceError("price_unavailable"));
      const graph = (svc(t1) as unknown as { graph: OrchestratorGraph }).graph;
      const again = await as(P, async () => {
        let target: Parameters<OrchestratorGraph["stream"]>[1] | undefined;
        for await (const snap of graph.getStateHistory({ configurable: { thread_id: threadId } })) {
          if (snap.next.includes("executor")) {
            target = snap.config;
            break;
          }
        }
        if (!target) throw new Error("checkpoint antes do executor não encontrado");
        for await (const chunk of await graph.stream(null, target)) void chunk;
        return graph.getState({ configurable: { thread_id: threadId } });
      });
      expect(priceFor).toHaveBeenCalledTimes(1);
      expect(again.values.pending).toEqual({ approvalId: approval.id });
      expect(again.values.errors["executor"]).toBeUndefined();
      expect(again.next).toEqual(["approval"]);
      // Uma linha só, a do 1º passe (sem órfã), com o payload e o valor da 1ª cotação.
      expect(await rowsOf(P, threadId)).toEqual(before);

      // E ela segue executável normalmente, uma vez.
      await decide(t1, P, approval.id, true);
      const out = await as(P, () => svc(t1).resume(threadId, true));
      expect(out.execution).toMatchObject({ approvalId: approval.id, status: "succeeded" });
      expect(placeTrade).toHaveBeenCalledTimes(1);
      expect(await executionUsage(P)).toEqual([{ price: "90.00", fee: "15.00", value: "3000.00" }]);
    });

    it("transfer não cota: valor do modelo, como hoje", async () => {
      const priceFor = vi.spyOn(t1.app.get(MarketService), "priceFor");
      mocks.executor = () => ({
        action: "transfer",
        payload: { amount: "500.00", to: "conta-1" },
        valueBrl: "500.00",
        rationale: "transferência",
      });
      const threadId = thread(A);
      const approval = approvalOf(await turn(t1, A, threadId, "transfira 500 reais"));
      expect(priceFor).not.toHaveBeenCalled();
      expect(await rowsOf(A, threadId)).toEqual([
        {
          id: approval.id,
          status: "pending",
          payload: { amount: "500.00", to: "conta-1" },
          value: "500.00",
        },
      ]);
    });
  });

  it("outro tenant não retoma nem lê o thread", async () => {
    const threadId = thread(A);
    const events = await turn(t1, A, threadId, "compre 9 ações de WEGE3");
    const last = events.at(-1);
    const approvalId = last?.type === "approval_required" ? last.approval.id : "";
    await decide(t1, A, approvalId, true);

    await expect(as(B, () => svc(t1).resume(threadId, true))).rejects.toThrow(NotFoundError);
    await expect(as(B, () => svc(t1).finalState(threadId))).rejects.toThrow(NotFoundError);
    expect(placeTrade).not.toHaveBeenCalled();
    // O dono ainda retoma normalmente.
    const out = await as(A, () => svc(t1).resume(threadId, true));
    expect(out.execution.status).toBe("succeeded");
  });

  describe("checkpoint no Postgres", () => {
    it("carina_app grava e lê checkpoints, mas não cria objetos no schema langgraph", async () => {
      await withPgClient(appUrl(), async (c) => {
        const { rows } = await c.query<{ v: number }>(
          `SELECT max(v) AS v FROM ${CHECKPOINT_SCHEMA}.checkpoint_migrations`,
        );
        expect(rows[0]?.v).toBe(CHECKPOINT_MIGRATION_VERSION);
        await expect(c.query(`CREATE TABLE langgraph.x (id int)`)).rejects.toMatchObject({
          code: "42501",
        });
        await expect(
          c.query(`INSERT INTO langgraph.checkpoint_migrations (v) VALUES (99)`),
        ).rejects.toMatchObject({ code: "42501" });
      });
    });

    it("paridade: as tabelas da 0005 são as do setup() original da versão fixada", async () => {
      const schema = `lg_parity_${process.pid}`;
      const pool = new pg.Pool({ connectionString: migratorUrl(), max: 1 });
      try {
        await new PostgresSaver(pool, undefined, { schema }).setup();
        const describe = (s: string) =>
          migratorSql<{ t: string; c: string; ty: string; nn: string; d: string | null }>(
            `SELECT table_name AS t, column_name AS c, data_type AS ty, is_nullable AS nn,
                    column_default AS d
               FROM information_schema.columns WHERE table_schema = $1
              ORDER BY table_name COLLATE "C", ordinal_position`,
            [s],
          );
        const pks = (s: string) =>
          migratorSql<{ t: string; cols: string }>(
            `SELECT tc.table_name AS t,
                    string_agg(k.column_name, ',' ORDER BY k.ordinal_position) AS cols
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage k
                 ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema
              WHERE tc.table_schema = $1 AND tc.constraint_type = 'PRIMARY KEY'
              GROUP BY tc.table_name ORDER BY tc.table_name COLLATE "C"`,
            [s],
          );
        // A ordem das colunas de checkpoint_writes pode diferir (ALTER ADD COLUMN): compara por nome.
        const byName = (rows: { t: string; c: string }[]) =>
          [...rows].sort((a, b) => (`${a.t}.${a.c}` < `${b.t}.${b.c}` ? -1 : 1));
        expect(byName(await describe(CHECKPOINT_SCHEMA))).toEqual(byName(await describe(schema)));
        expect(await pks(CHECKPOINT_SCHEMA)).toEqual(await pks(schema));
        const versions = (s: string) =>
          migratorSql<{ v: number }>(`SELECT v FROM ${s}.checkpoint_migrations ORDER BY v`);
        expect(await versions(CHECKPOINT_SCHEMA)).toEqual(await versions(schema));
      } finally {
        await pool.end();
        await migratorSql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    });
  });
});
