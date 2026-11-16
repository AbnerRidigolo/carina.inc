/**
 * Agentes com Nest, Postgres e Redis reais, em LLM_MODE=mock: os responders são registrados no
 * boot do AgentsModule e o Executor só PROPÕE (não grava `approval_request` nem `executed_action`;
 * quem registra a solicitação é o nó executor do grafo, com o preço de servidor do `place_trade`).
 */
import { HumanMessage } from "@langchain/core/messages";
import { CashFlowForecastSchema } from "@carina/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
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
    ({ tenantId: tenantB } = await party("Agentes B"));
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

  it("executor só PROPÕE pelo registry real: ordem e alerta viram propostas, sem aprovação nem execução", async () => {
    expect("request" in agents.executor()).toBe(false);
    const order = await TenantContext.run({ tenantId: tenantA, clientId: clientA }, () =>
      agents.executor().run({ question: "compre 100 ações de PETR4", history: [], knowledge }),
    );
    expect(order).toMatchObject({
      action: "place_trade",
      payload: { side: "buy", assetCode: "PETR4", quantity: 100 },
    });
    const alert = await TenantContext.run({ tenantId: tenantA, clientId: clientA }, () =>
      agents.executor().run({ question: "me avise sobre o dólar", history: [], knowledge }),
    );
    expect(alert).toMatchObject({ action: "create_alert", valueBrl: "0.00" });
    // A solicitação de aprovação é do nó executor do grafo (preço de servidor no place_trade).
    expect(await approvals(tenantA)).toHaveLength(0);
    expect(await approvals(tenantB)).toHaveLength(0);
    expect(await executions(tenantA)).toHaveLength(0);
  });
});
