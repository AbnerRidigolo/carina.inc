import { ProblemSchema, UsageSummarySchema } from "@carina/shared";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { BillingModule } from "../../src/modules/billing/billing.module.js";
import { BillingService } from "../../src/modules/billing/billing.service.js";
import { monthKey } from "../../src/modules/limits/month.js";
import { createTestApp, type SeededTenant, type TestApp } from "../setup/app.js";
import { redisDbOf } from "../setup/redis-dbs.js";

// Os registros levam created_at = now() do banco; o mês corrente vem do CLOCK do app.
const MONTH = monthKey(Date.now());

describe("Billing E2E: GET /api/usage", () => {
  let t: TestApp;
  let server: Parameters<typeof request>[0];
  let A: SeededTenant;
  let B: SeededTenant;
  let billing: BillingService;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [BillingModule],
      redisDb: redisDbOf("billing/billing.e2e.spec.ts"),
    });
    server = t.app.getHttpServer() as Parameters<typeof request>[0];
    billing = t.app.get(BillingService);
    A = await t.seedTenant({ name: "A" });
    B = await t.seedTenant({ name: "B" });
    await TenantContext.run({ tenantId: A.tenantId }, async () => {
      await billing.record({ workType: "query", agents: [], durationMs: 1 });
      await billing.record({
        workType: "execution",
        agents: [],
        valueBrl: new Prisma.Decimal("100000"),
        durationMs: 1,
      });
    });
    await TenantContext.run({ tenantId: B.tenantId }, async () => {
      await billing.record({ workType: "analysis", agents: ["x"], durationMs: 1 });
    });
  });

  afterAll(async () => {
    await t.close();
  });

  const get = (path: string, key?: string) =>
    request(server)
      .get(path)
      .set(key ? { Authorization: `Bearer ${key}` } : {});

  it("devolve o resumo do mês corrente só do tenant da chave", async () => {
    const res = await get("/api/usage", A.keys.chat);
    expect(res.status).toBe(200);
    const body = UsageSummarySchema.parse(res.body);
    expect(body).toEqual({
      month: MONTH,
      resolutions: 2,
      totalBrl: "576.50",
      byWorkType: {
        query: { count: 1, totalBrl: "1.50" },
        execution: { count: 1, totalBrl: "575.00" },
      },
    });

    const resB = await get(`/api/usage?month=${MONTH}`, B.keys.chat);
    expect(UsageSummarySchema.parse(resB.body)).toEqual({
      month: MONTH,
      resolutions: 1,
      totalBrl: "7.50",
      byWorkType: { analysis: { count: 1, totalBrl: "7.50" } },
    });
  });

  it("?month= de outro mês vem vazio", async () => {
    const res = await get("/api/usage?month=2020-04", A.keys.chat);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      month: "2020-04",
      resolutions: 0,
      totalBrl: "0.00",
      byWorkType: {},
    });
  });

  it("mês inválido: 422 problem+json", async () => {
    const res = await get("/api/usage?month=2026-13", A.keys.chat);
    expect(res.status).toBe(422);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(ProblemSchema.parse(res.body).status).toBe(422);
  });

  it("sem chave: 401; sem o escopo chat: 403", async () => {
    expect((await get("/api/usage")).status).toBe(401);
    expect((await get("/api/usage", A.keys.ingest)).status).toBe(403);
  });
});
