/**
 * Agentes com Nest, Postgres e Redis reais, em LLM_MODE=mock: os responders são registrados no
 * boot do AgentsModule e o Executor só PROPÕE (a solicitação vira `approval_request` pendente, sem
 * `executed_action`), isolada por tenant e cliente.
 */
import { randomUUID } from "node:crypto";
import { HumanMessage } from "@langchain/core/messages";
import { CashFlowForecastSchema } from "@carina/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import { ValidationError } from "../../src/core/errors/domain-errors.js";
import { AgentRegistry } from "../../src/modules/agents/agent-registry.js";
import { AgentsModule } from "../../src/modules/agents/agents.module.js";
import { MockResponderRegistry } from "../../src/modules/llm/mock-models.js";
import { createTestApp, type TestApp } from "../setup/app.js";
import { migratorSql, must } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

const knowledge = { chunks: [], entities: [], neighbors: [] };

describe("Agentes (int)", () => {
  let t: TestApp;
  let agents: AgentRegistry;
  let tenantA: string;
  let clientA: string;
  let tenantB: string;
  let clientB: string;

  async function party(name: string) {
    const seeded = await t.seedTenant({ name });
    const [c] = await migratorSql<{ id: string }>(
      `INSERT INTO client (tenant_id, external_id) VALUES ($1, 'cli-1') RETURNING id`,
      [seeded.tenantId],
      { tenantId: seeded.tenantId },
    );
    return { tenantId: seeded.tenantId, clientId: must(c).id };
  }

  const approvals = (tenantId: string) =>
    migratorSql<Record<string, unknown>>(`SELECT * FROM approval_request`, [], { tenantId });
  const executions = (tenantId: string) =>
    migratorSql<Record<string, unknown>>(`SELECT * FROM executed_action`, [], { tenantId });

  beforeAll(async () => {
    t = await createTestApp({
      imports: [AgentsModule],
      redisDb: redisDbOf("agents/agents.int.spec.ts"),
    });
    agents = t.app.get(AgentRegistry);
    ({ tenantId: tenantA, clientId: clientA } = await party("Agentes A"));
    ({ tenantId: tenantB, clientId: clientB } = await party("Agentes B"));
  });

  afterAll(async () => {
    await t?.close();
  });

  it("registra os responders dos agentes no boot, menos o classifier (Task 18)", () => {
    const mocks = t.app.get(MockResponderRegistry);
    for (const k of ["navigator", "synthesize", "insight", "predictor", "risk", "executor"]) {
      expect(mocks.has(k)).toBe(true);
    }
    expect(mocks.has("classifier")).toBe(false);
  });

  it("predictor devolve previsão válida pelo registry real", async () => {
    const out = await agents
      .get("predictor")
      .run({ question: "projete", history: [new HumanMessage("oi")], knowledge });
    expect(CashFlowForecastSchema.safeParse(out).success).toBe(true);
  });

  it("executor.request cria aprovação pendente irreversível e não executa nada", async () => {
    const threadId = `${tenantA}:${clientA}:${randomUUID()}`;
    const res = await TenantContext.run({ tenantId: tenantA, clientId: clientA }, () =>
      agents
        .executor()
        .request({ question: "compre 100 ações de PETR4", history: [], knowledge }, threadId),
    );
    expect(res.created).toBe(true);
    expect(res.proposal.valueBrl).toBe("3000.00");

    const rows = await approvals(tenantA);
    const row = must(rows[0]);
    expect(rows).toHaveLength(1);
    expect(row["id"]).toBe(res.approvalId);
    expect(row["status"]).toBe("pending");
    expect(row["risk"]).toBe("irreversible");
    expect(row["agent"]).toBe("executor");
    expect(row["action"]).toBe("place_trade");
    expect(row["payload"]).toEqual({ side: "buy", assetCode: "PETR4", quantity: 100 });
    expect(await executions(tenantA)).toHaveLength(0);

    // Reexecutar o nó (retomada) é idempotente.
    const again = await TenantContext.run({ tenantId: tenantA, clientId: clientA }, () =>
      agents
        .executor()
        .request({ question: "compre 100 ações de PETR4", history: [], knowledge }, threadId),
    );
    expect(again).toMatchObject({ approvalId: res.approvalId, created: false });
    expect(await approvals(tenantA)).toHaveLength(1);
  });

  it("pedido sem ordem vira create_alert reversível, ainda sem executar", async () => {
    const threadId = `${tenantA}:${clientA}:${randomUUID()}`;
    await TenantContext.run({ tenantId: tenantA, clientId: clientA }, () =>
      agents
        .executor()
        .request({ question: "me avise sobre o dólar", history: [], knowledge }, threadId),
    );
    const alert = (await approvals(tenantA)).find((r) => r["action"] === "create_alert");
    expect(must(alert)["risk"]).toBe("reversible");
    expect(await executions(tenantA)).toHaveLength(0);
  });

  it("isolamento: o outro tenant não vê a aprovação e threadId alheio é recusado", async () => {
    expect(await approvals(tenantB)).toHaveLength(0);
    const forged = `${tenantA}:${clientA}:${randomUUID()}`;
    await expect(
      TenantContext.run({ tenantId: tenantB, clientId: clientB }, () =>
        agents.executor().request({ question: "compre 1 PETR4", history: [], knowledge }, forged),
      ),
    ).rejects.toThrow(ValidationError);
    expect(await approvals(tenantB)).toHaveLength(0);
  });

  it("sem cliente no contexto a proposta não vira solicitação", async () => {
    await expect(
      TenantContext.run({ tenantId: tenantA }, () =>
        agents
          .executor()
          .request(
            { question: "compre 1 PETR4", history: [], knowledge },
            `${tenantA}:${clientA}:${randomUUID()}`,
          ),
      ),
    ).rejects.toThrow(ValidationError);
  });
});
