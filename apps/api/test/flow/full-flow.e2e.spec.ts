/**
 * Fluxo completo da demo, ponta a ponta, sobre a fiação REAL de produção:
 * - o seed de demo de verdade (`seed()`: tenant `demo`, chaves DEMO_* padrão, três clientes
 *   sintéticos já sincronizados);
 * - o bootstrap de verdade (`createApiApp()`, o mesmo do main.ts) com LLM_MODE=mock e
 *   WORKERS_ENABLED=true: a execução aprovada passa pelo ResumeWorker (stream `jobs`) →
 *   orquestrador (retomada do grafo) → `executeOnce`, sem nenhum atalho no teste.
 *
 * Roteiro: chat pede a compra → aprovação pendente → chave app não decide (403) → chave
 * aprovadora decide (200) → em até 10 s a execução está cobrada (1 `query` R$ 1,50 + 1
 * `execution` R$ 90,00 = 75,00 + 0,5% de 3.000,00, além dos 6 lotes de `data_ingestion` do seed)
 * e auditada, e a inbox fica vazia. Depois:
 * segunda decisão → 409 sem nova execução nem cobrança, uma única linha em `executed_action`, e
 * um segundo tenant não enxerga nada disso.
 *
 * Redis: DB lógico próprio (test/setup/redis-dbs.ts). O ConfigModule lê `process.env` (como em
 * produção): o teste fixa as variáveis antes do boot e as restaura no fim.
 */
import type http from "node:http";
import {
  ApprovalViewSchema,
  AuditEventViewSchema,
  ChatResponseSchema,
  UsageSummarySchema,
  type UsageSummary,
} from "@carina/shared";
import type { INestApplication } from "@nestjs/common";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiApp } from "../../src/bootstrap.js";
import { generateApiKey } from "../../src/modules/tenancy/api-key.js";
import { DEFAULT_DEMO_APP_KEY, DEFAULT_DEMO_APPROVER_KEY, seed } from "../../src/seed/seed.js";
import { appUrl, migratorSql, migratorUrl, must, redisDbUrl } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

const REDIS_DB = redisDbOf("flow/full-flow.e2e.spec.ts");
const CLIENT = "cliente-moderado";
const QUESTION = "compre 100 ações de PETR4";

/** Espera a condição assíncrona com prazo (sem sleeps fixos no lugar de asserções). */
async function eventually<T>(
  probe: () => Promise<T | undefined>,
  ms: number,
  what: string,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= end) throw new Error(`Tempo esgotado (${ms} ms) esperando ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("fluxo completo: chat → aprovação → execução única, cobrada e auditada", () => {
  const saved = { ...process.env };
  let app: INestApplication;
  let server: http.Server;
  let tenantId: string;
  let otherKey: string;
  let approvalId: string;

  const as = (key: string) => ({
    get: (path: string) => request(server).get(path).set("Authorization", `Bearer ${key}`),
    post: (path: string, body: object) =>
      request(server).post(path).set("Authorization", `Bearer ${key}`).send(body),
  });
  const appKey = as(DEFAULT_DEMO_APP_KEY);
  const approver = as(DEFAULT_DEMO_APPROVER_KEY);

  const usageOf = async (key: string): Promise<UsageSummary> => {
    const res = await as(key).get("/api/usage");
    expect(res.status).toBe(200);
    return UsageSummarySchema.parse(res.body);
  };
  const executedActions = () =>
    migratorSql<{ status: string }>(
      `SELECT status FROM executed_action WHERE approval_request_id = $1`,
      [approvalId],
      { tenantId },
    );

  beforeAll(async () => {
    const env = {
      NODE_ENV: "test",
      DATABASE_URL: appUrl(),
      MIGRATION_DATABASE_URL: migratorUrl(),
      REDIS_URL: redisDbUrl(REDIS_DB),
      LLM_MODE: "mock",
      LOG_LEVEL: "silent",
      DEMO_APP_KEY: "",
      DEMO_APPROVER_KEY: "",
      SEED_ALLOW_DEMO_KEYS: "",
    };
    const redis = new Redis(redisDbUrl(REDIS_DB));
    try {
      await redis.flushdb();
      tenantId = (await seed({ env: { ...process.env, ...env }, logger: silentLogger })).tenantId;
      // O seed já sincronizou os clientes; os eventos data.ingested que ele publicou não precisam
      // de outro passe do SyncWorker (que só concorreria com o teste pelo banco).
      await redis.flushdb();
    } finally {
      await redis.quit();
    }

    Object.assign(process.env, env, { WORKERS_ENABLED: "true" });
    app = await createApiApp();
    await app.listen(0, "127.0.0.1");
    server = app.getHttpServer() as http.Server;

    // Um segundo tenant, para a checagem de isolamento.
    const [other] = await migratorSql<{ id: string }>(
      `INSERT INTO tenant (name, plan, rpm, monthly_quota) VALUES ('Outro', 'pro', 1000, 0) RETURNING id`,
    );
    const generated = generateApiKey();
    await migratorSql(
      `INSERT INTO api_key (tenant_id, hash, prefix, scopes) VALUES ($1, $2, $3, $4)`,
      [must(other).id, generated.hash, generated.prefix, ["chat", "inbox:decide"]],
    );
    otherKey = generated.key;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    process.env = saved;
  });

  it("1. chave app: o pedido de compra pausa aguardando aprovação", async () => {
    const res = await appKey.post("/api/chat", { clientId: CLIENT, message: QUESTION });
    expect(res.status).toBe(200);
    const body = ChatResponseSchema.parse(res.body);
    expect(body.status).toBe("awaiting_approval");
    // O pedido de compra não aciona especialistas: o plano não tem agentes → `query`.
    expect(body.plan.agents).toEqual([]);
    expect(body.plan.wantsExecution).toBe(true);
    expect(body.usage).toEqual({ workType: "query", priceBrl: "1.50" });
    const approval = ApprovalViewSchema.parse(body.approval);
    expect(approval).toMatchObject({
      clientId: CLIENT,
      agent: "executor",
      action: "place_trade",
      risk: "irreversible",
      status: "pending",
      valueBrl: "3000.00",
      payload: { side: "buy", assetCode: "PETR4", quantity: 100 },
    });
    approvalId = approval.id;

    const inbox = await appKey.get(`/api/clients/${CLIENT}/inbox`);
    expect(inbox.status).toBe(200);
    expect((inbox.body as unknown[]).map((v) => ApprovalViewSchema.parse(v).id)).toEqual([
      approvalId,
    ]);
  });

  it("2. a chave app não tem inbox:decide: 403 e nada é executado", async () => {
    const res = await appKey.post(`/api/inbox/${approvalId}/decision`, { approved: true });
    expect(res.status).toBe(403);
    expect(await executedActions()).toEqual([]);
  });

  it("3. a chave aprovadora aprova: 200", async () => {
    const res = await approver.post(`/api/inbox/${approvalId}/decision`, {
      approved: true,
      reason: "ok do assessor",
    });
    expect(res.status).toBe(200);
    expect(ApprovalViewSchema.parse(res.body)).toMatchObject({
      id: approvalId,
      status: "approved",
    });
  });

  it("4. em até 10 s o worker executa uma vez e o uso mostra 1 query (1,50) e 1 execution (90,00)", async () => {
    // Sonda o banco (não a API: o tenant demo tem rpm 120 e a sondagem não pode gastar o limite).
    // `succeeded` só é gravado na mesma transação da cobrança e da auditoria.
    await eventually(
      async () => ((await executedActions())[0]?.status === "succeeded" ? true : undefined),
      10_000,
      "a execução aprovada terminar",
    );
    const usage = await usageOf(DEFAULT_DEMO_APP_KEY);
    // O seed ingere pelo IngestionService, que mede cada lote como data_ingestion (spec §6.4):
    // 3 clientes × (posições + transações) = 6 lotes × R$ 0,05. O seed pula clientes já semeados,
    // então isso acontece uma vez só. O turno do chat e a execução vêm em cima disso.
    expect(usage.byWorkType).toEqual({
      data_ingestion: { count: 6, totalBrl: "0.30" },
      query: { count: 1, totalBrl: "1.50" },
      execution: { count: 1, totalBrl: "90.00" },
    });
    expect(usage.resolutions).toBe(8);
    expect(usage.totalBrl).toBe("91.80");

    // 90,00 = 75,00 (preço base) + 15,00 (0,5% de 3.000,00 movimentados).
    const [row] = await migratorSql<{ price: string; fee: string; value: string }>(
      `SELECT price_brl::text AS price, fee_brl::text AS fee, value_brl::text AS value
       FROM usage_record WHERE work_type = 'execution'`,
      [],
      { tenantId },
    );
    expect(row).toEqual({ price: "90.00", fee: "15.00", value: "3000.00" });
    expect(await executedActions()).toEqual([{ status: "succeeded" }]);
  });

  it("5. a auditoria tem o evento do chat e o da execução", async () => {
    const res = await appKey.get("/api/audit");
    expect(res.status).toBe(200);
    const events = (res.body as unknown[]).map((e) => AuditEventViewSchema.parse(e));
    expect(events).toHaveLength(2);
    // A trilha leva o uuid interno do cliente (contrato do Watchtower), não o externalId.
    const [client] = await migratorSql<{ id: string }>(
      `SELECT id FROM client WHERE external_id = $1`,
      [CLIENT],
      { tenantId },
    );
    const clientId = must(client).id;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "rest", query: QUESTION, agents: [], clientId }),
        expect.objectContaining({
          channel: "worker",
          query: "execute:place_trade",
          agents: ["executor"],
          clientId,
        }),
      ]),
    );
  });

  it("6. a inbox do cliente volta vazia", async () => {
    const res = await appKey.get(`/api/clients/${CLIENT}/inbox`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("segunda decisão → 409, sem nova execução nem nova cobrança", async () => {
    const before = await usageOf(DEFAULT_DEMO_APP_KEY);
    for (const approved of [true, false]) {
      const res = await approver.post(`/api/inbox/${approvalId}/decision`, { approved });
      expect(res.status).toBe(409);
    }
    expect(await usageOf(DEFAULT_DEMO_APP_KEY)).toEqual(before);
    // executed_action tem chave primária na aprovação: no máximo uma linha, e ela já terminou.
    expect(await executedActions()).toEqual([{ status: "succeeded" }]);
    const [n] = await migratorSql<{ n: string }>(
      `SELECT count(*)::text AS n FROM executed_action`,
      [],
      { tenantId },
    );
    expect(must(n).n).toBe("1");
  });

  it("outro tenant não enxerga uso, auditoria, inbox nem a aprovação deste", async () => {
    const usage = await usageOf(otherKey);
    expect(usage.resolutions).toBe(0);
    expect(usage.byWorkType).toEqual({});

    const audit = await as(otherKey).get("/api/audit");
    expect(audit.status).toBe(200);
    expect(audit.body).toEqual([]);

    // O cliente é deste tenant: para o outro, ele não existe.
    expect((await as(otherKey).get(`/api/clients/${CLIENT}/inbox`)).status).toBe(404);
    // A aprovação também não: 404 (não 409), sem revelar que existe.
    const decision = await as(otherKey).post(`/api/inbox/${approvalId}/decision`, {
      approved: false,
    });
    expect(decision.status).toBe(404);
    expect(await executedActions()).toEqual([{ status: "succeeded" }]);
  });
});

const silentLogger = { info: () => undefined, warn: () => undefined };
