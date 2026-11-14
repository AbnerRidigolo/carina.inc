/**
 * Rotas /api/market/*: escopo `market:read`, cobrança `data_query` (R$ 0,05) só após o sucesso do
 * serviço, validação 422 sem cobrança e 502 sem texto interno quando o provedor falha.
 * Redis: DB lógico próprio (test/setup/redis-dbs.ts), esvaziado a cada teste.
 */
import {
  MarketHistoryResponseSchema,
  MarketMacroResponseSchema,
  MarketQuotesResponseSchema,
  ProblemSchema,
  UsageSummarySchema,
} from "@carina/shared";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MarketDataUnavailableError } from "../../src/core/errors/domain-errors.js";
import { MarketModule } from "../../src/modules/market/market.module.js";
import { MACRO_PROVIDER, MARKET_DATA_PROVIDER } from "../../src/modules/market/market.service.js";
import { BillingModule } from "../../src/modules/billing/billing.module.js";
import { createTestApp, type SeededTenant, type TestApp } from "../setup/app.js";
import { redisDbUrl } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

const REDIS_DB = redisDbOf("market/market.e2e.spec.ts");

function setup(overrides: { token: unknown; useValue: unknown }[] = []) {
  const ctx: {
    t?: TestApp;
    A?: SeededTenant;
    server?: Parameters<typeof request>[0];
    redis?: Redis;
  } = {};
  beforeAll(async () => {
    ctx.t = await createTestApp({
      imports: [MarketModule, BillingModule],
      overrides,
      redisDb: REDIS_DB,
      env: { MARKET_MODE: "mock" },
    });
    ctx.server = ctx.t.app.getHttpServer() as Parameters<typeof request>[0];
    ctx.A = await ctx.t.seedTenant({ name: "Mercado" });
    ctx.redis = new Redis(redisDbUrl(REDIS_DB));
  });
  afterAll(async () => {
    await ctx.redis?.quit();
    await ctx.t?.close();
  });
  beforeEach(async () => {
    await ctx.redis?.flushdb();
  });
  const get = (path: string, key?: string) =>
    request(ctx.server as Parameters<typeof request>[0])
      .get(path)
      .set(key ? { Authorization: `Bearer ${key}` } : {});
  const dataQueries = async (): Promise<number> => {
    const res = await get("/api/usage", (ctx.A as SeededTenant).keys.chat);
    return UsageSummarySchema.parse(res.body).byWorkType.data_query?.count ?? 0;
  };
  return { ctx, get, dataQueries };
}

describe("Market E2E (mock)", () => {
  const { ctx, get, dataQueries } = setup();
  const key = () => (ctx.A as SeededTenant).keys.market;

  it("sem market:read → 403 problem+json, sem cobrança", async () => {
    const res = await get("/api/market/quotes?symbols=PETR4", (ctx.A as SeededTenant).keys.chat);
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(await dataQueries()).toBe(0);
  });

  it("quotes: 200 com PETR4 a 30.00; cobra data_query; acerto de cache também é cobrado", async () => {
    const before = await dataQueries();
    const res = await get("/api/market/quotes?symbols=PETR4", key());
    expect(res.status).toBe(200);
    const body = MarketQuotesResponseSchema.parse(res.body);
    expect(body.quotes[0]?.price).toBe("30.00");
    expect(body.usage).toEqual({ workType: "data_query", priceBrl: "0.05" });
    expect(await dataQueries()).toBe(before + 1);

    await get("/api/market/quotes?symbols=PETR4", key()).expect(200);
    expect(await dataQueries()).toBe(before + 2);
    const usage = UsageSummarySchema.parse(
      (await get("/api/usage", (ctx.A as SeededTenant).keys.chat)).body,
    );
    expect(usage.byWorkType.data_query?.totalBrl).toBe("0.10");
  });

  it("quotes: duplicados viram um símbolo", async () => {
    const res = await get("/api/market/quotes?symbols=PETR4,%20PETR4,,VALE3", key()).expect(200);
    expect(MarketQuotesResponseSchema.parse(res.body).quotes.map((q) => q.symbol)).toEqual([
      "PETR4",
      "VALE3",
    ]);
  });

  it.each([
    ["vazio", "/api/market/quotes?symbols="],
    ["sem parâmetro", "/api/market/quotes"],
    ["só vírgulas", "/api/market/quotes?symbols=,,"],
    ["minúsculo", "/api/market/quotes?symbols=petr4"],
    ["path traversal", "/api/market/quotes?symbols=PETR4/../x"],
    [
      "21 símbolos",
      `/api/market/quotes?symbols=${Array.from({ length: 21 }, (_, i) => `AAA${String(i + 10)}`).join(",")}`,
    ],
    ["range inválido", "/api/market/history/PETR4?range=10y"],
    ["símbolo inválido no histórico", "/api/market/history/petr4"],
  ])("422 sem cobrança: %s", async (_name, path) => {
    const before = await dataQueries();
    const res = await get(path, key());
    expect(res.status).toBe(422);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(await dataQueries()).toBe(before);
  });

  it("history: padrão 3mo devolve barras do mock e cobra", async () => {
    const before = await dataQueries();
    const res = await get("/api/market/history/PETR4", key()).expect(200);
    const body = MarketHistoryResponseSchema.parse(res.body);
    expect(body.symbol).toBe("PETR4");
    expect(body.range).toBe("3mo");
    expect(body.bars.length).toBeGreaterThan(0);
    expect(await dataQueries()).toBe(before + 1);
  });

  it("macro: quatro indicadores e cobra", async () => {
    const before = await dataQueries();
    const res = await get("/api/market/macro", key()).expect(200);
    expect(MarketMacroResponseSchema.parse(res.body).indicators).toHaveLength(4);
    expect(await dataQueries()).toBe(before + 1);
  });
});

describe("Market E2E (provedor falhando)", () => {
  const failing = () => Promise.reject(new MarketDataUnavailableError());
  const { ctx, get, dataQueries } = setup([
    {
      token: MARKET_DATA_PROVIDER,
      useValue: { fetchQuotes: failing, fetchHistory: failing },
    },
    { token: MACRO_PROVIDER, useValue: { fetchMacro: failing } },
  ]);

  it.each(["/api/market/quotes?symbols=PETR4", "/api/market/history/PETR4", "/api/market/macro"])(
    "502 problem+json sem texto interno e sem cobrança: %s",
    async (path) => {
      const res = await get(path, (ctx.A as SeededTenant).keys.market);
      expect(res.status).toBe(502);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      const problem = ProblemSchema.parse(res.body);
      expect(JSON.stringify(problem)).not.toMatch(/brapi|bcb|fetch|stack|ECONN/i);
      expect(await dataQueries()).toBe(0);
    },
  );
});
