/**
 * Rotas /api/builder/*: escopo `builder:run`, estratégias por tenant (RLS) e backtest cobrado como
 * `backtest` (R$ 7,50) só no sucesso, com reserva da cota mensal. 404/422/502/503/429 nunca
 * cobram. Histórico: mock do MarketService (MARKET_MODE=mock). Redis: DB lógico próprio
 * (test/setup/redis-dbs.ts), esvaziado a cada teste.
 */
import { Writable } from "node:stream";
import { BacktestResultSchema, StrategySchema, UsageSummarySchema } from "@carina/shared";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MarketDataUnavailableError } from "../../src/core/errors/domain-errors.js";
import { LoggingModule } from "../../src/core/logging/logging.module.js";
import { BillingModule } from "../../src/modules/billing/billing.module.js";
import { BuilderModule } from "../../src/modules/builder/builder.module.js";
import { MARKET_DATA_PROVIDER } from "../../src/modules/market/market.service.js";
import { createTestApp, type SeededTenant, type TestApp } from "../setup/app.js";
import { redisDbUrl } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

const REDIS_DB = redisDbOf("builder/builder.e2e.spec.ts");
const BASE = "/api/builder/strategies";
const SMA = { kind: "sma_cross", symbol: "PETR4", fast: 5, slow: 20 };
const HOLD = { kind: "buy_hold", symbol: "PETR4" };
const UNKNOWN_ID = "11111111-1111-4111-8111-111111111111";

function setup(
  opts: {
    overrides?: { token: unknown; useValue: unknown }[];
    env?: Record<string, string>;
    logDestination?: Writable;
  } = {},
) {
  const ctx: {
    t?: TestApp;
    A?: SeededTenant;
    B?: SeededTenant;
    server?: Parameters<typeof request>[0];
    redis?: Redis;
  } = {};
  beforeAll(async () => {
    ctx.t = await createTestApp({
      imports: [
        ...(opts.logDestination
          ? [LoggingModule.forRoot({ destination: opts.logDestination })]
          : []),
        BuilderModule,
        BillingModule,
      ],
      overrides: opts.overrides ?? [],
      redisDb: REDIS_DB,
      env: { MARKET_MODE: "mock", ...opts.env },
    });
    ctx.server = ctx.t.app.getHttpServer() as Parameters<typeof request>[0];
    ctx.A = await ctx.t.seedTenant({ name: "Builder A" });
    ctx.B = await ctx.t.seedTenant({ name: "Builder B" });
    ctx.redis = new Redis(redisDbUrl(REDIS_DB));
  });
  afterAll(async () => {
    await ctx.redis?.quit();
    await ctx.t?.close();
  });
  beforeEach(async () => {
    await ctx.redis?.flushdb();
  });
  const srv = () => ctx.server as Parameters<typeof request>[0];
  const get = (path: string, k?: string) =>
    request(srv())
      .get(path)
      .set(k ? { Authorization: `Bearer ${k}` } : {});
  const post = (path: string, body: unknown, k?: string) =>
    request(srv())
      .post(path)
      .set(k ? { Authorization: `Bearer ${k}` } : {})
      .send(body as object);
  const backtests = async (t: SeededTenant): Promise<{ count: number; totalBrl: string }> => {
    const res = await get("/api/usage", t.keys.chat);
    return UsageSummarySchema.parse(res.body).byWorkType.backtest ?? { count: 0, totalBrl: "0.00" };
  };
  const create = async (t: SeededTenant, spec: unknown = SMA, name = "Cruzamento") => {
    const res = await post(BASE, { name, spec }, t.keys.builder).expect(201);
    return StrategySchema.parse(res.body);
  };
  return { ctx, get, post, backtests, create };
}

describe("Builder E2E", () => {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(...chunk.toString().split("\n").filter(Boolean));
      cb();
    },
  });
  const { ctx, get, post, backtests, create } = setup({
    logDestination: destination,
    env: { LOG_LEVEL: "info" },
  });
  const A = () => ctx.A as SeededTenant;
  const B = () => ctx.B as SeededTenant;

  it("sem builder:run → 403 problem+json, sem cobrança", async () => {
    const before = (await backtests(A())).count;
    const chat = A().keys.chat;
    const res = await get(BASE, chat);
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    await post(BASE, { name: "x", spec: SMA }, chat).expect(403);
    await post(`${BASE}/${UNKNOWN_ID}/backtest`, {}, chat).expect(403);
    expect((await backtests(A())).count).toBe(before);
  });

  it("sem chave → 401", async () => {
    await get(BASE).expect(401);
  });

  it("cria (201), lista e lê; criar/listar/ler não cobram", async () => {
    const before = (await backtests(A())).count;
    const created = await create(A(), SMA, "Minha SMA");
    expect(created.spec).toEqual(SMA);
    const list = await get(BASE, A().keys.builder).expect(200);
    const items = (list.body as unknown[]).map((s) => StrategySchema.parse(s));
    expect(items.map((s) => s.id)).toContain(created.id);
    const one = await get(`${BASE}/${created.id}`, A().keys.builder).expect(200);
    expect(StrategySchema.parse(one.body)).toEqual(created);
    expect((await backtests(A())).count).toBe(before);
  });

  it("spec inválida → 422", async () => {
    const k = A().keys.builder;
    await post(BASE, { name: "x", spec: { ...SMA, fast: 30, slow: 20 } }, k).expect(422);
    await post(BASE, { name: "x", spec: { ...SMA, symbol: "petr4" } }, k).expect(422);
    await post(BASE, { name: "x", spec: { ...SMA, kind: "martingale" } }, k).expect(422);
    await post(BASE, { name: "", spec: SMA }, k).expect(422);
    await post(BASE, { spec: SMA }, k).expect(422);
  });

  it("estratégia de outro tenant → 404 no GET e no backtest, sem cobrança", async () => {
    const mine = await create(A());
    const before = (await backtests(B())).count;
    await get(`${BASE}/${mine.id}`, B().keys.builder).expect(404);
    await post(`${BASE}/${mine.id}/backtest`, {}, B().keys.builder).expect(404);
    const list = await get(BASE, B().keys.builder).expect(200);
    expect((list.body as { id: string }[]).map((s) => s.id)).not.toContain(mine.id);
    expect((await backtests(B())).count).toBe(before);
    expect((await backtests(A())).count).toBe(0);
  });

  it("id malformado ou inexistente → 404, sem cobrança", async () => {
    const k = A().keys.builder;
    await get(`${BASE}/nao-e-uuid`, k).expect(404);
    await post(`${BASE}/nao-e-uuid/backtest`, {}, k).expect(404);
    await get(`${BASE}/${UNKNOWN_ID}`, k).expect(404);
    expect((await backtests(A())).count).toBe(0);
  });

  it("backtest cobra uma vez (usage backtest 7.50)", async () => {
    const s = await create(A());
    const before = await backtests(A());
    const res = await post(`${BASE}/${s.id}/backtest`, {}, A().keys.builder);
    expect(res.status).toBe(200);
    const body = BacktestResultSchema.parse(res.body);
    expect(body.usage).toEqual({ workType: "backtest", priceBrl: "7.50" });
    expect(body.symbol).toBe("PETR4");
    expect(body.kind).toBe("sma_cross");
    expect(body.bars).toBe(252);
    expect(body.equityCurve).toHaveLength(252);
    const after = await backtests(A());
    expect(after.count).toBe(before.count + 1);
    expect(Number(after.totalBrl) - Number(before.totalBrl)).toBe(7.5);
  });

  it("backtest respeita o range e é determinístico", async () => {
    const s = await create(A(), HOLD, "Buy and hold");
    const r1 = await post(`${BASE}/${s.id}/backtest?range=3mo`, {}, A().keys.builder).expect(200);
    const r2 = await post(`${BASE}/${s.id}/backtest?range=3mo`, {}, A().keys.builder).expect(200);
    expect(BacktestResultSchema.parse(r1.body).bars).toBe(63);
    expect(r2.body).toEqual(r1.body);
  });

  it("range inválido → 422 sem cobrança", async () => {
    const s = await create(A());
    const before = (await backtests(A())).count;
    await post(`${BASE}/${s.id}/backtest?range=10y`, {}, A().keys.builder).expect(422);
    expect((await backtests(A())).count).toBe(before);
  });

  it("histórico insuficiente → 422 sem cobrança", async () => {
    const s = await create(A(), { kind: "sma_cross", symbol: "PETR4", fast: 5, slow: 100 });
    const before = (await backtests(A())).count;
    const res = await post(`${BASE}/${s.id}/backtest?range=1mo`, {}, A().keys.builder);
    expect(res.status).toBe(422);
    expect((await backtests(A())).count).toBe(before);
  });

  it("símbolo desconhecido do mock (sem barras) → 422 sem cobrança", async () => {
    const s = await create(A(), { kind: "buy_hold", symbol: "ZZZZ3" });
    const before = (await backtests(A())).count;
    await post(`${BASE}/${s.id}/backtest`, {}, A().keys.builder).expect(422);
    expect((await backtests(A())).count).toBe(before);
  });

  it("nenhum log contém o nome da estratégia", async () => {
    const name = "NOME-SECRETO-da-estrategia-4c1d";
    const s = await create(A(), SMA, name);
    await post(`${BASE}/${s.id}/backtest`, {}, A().keys.builder).expect(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("NOME-SECRETO");
  });

  describe("cota mensal", () => {
    it("cota 1: o primeiro backtest passa, o segundo → 429 com Retry-After, 1 cobrança só", async () => {
      const T = await (ctx.t as TestApp).seedTenant({ name: "Cota builder", monthlyQuota: 1 });
      const s = await create(T);
      await post(`${BASE}/${s.id}/backtest`, {}, T.keys.builder).expect(200);
      const res = await post(`${BASE}/${s.id}/backtest`, {}, T.keys.builder);
      expect(res.status).toBe(429);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
      expect((await backtests(T)).count).toBe(1);
    });

    it("cota 1: um 422 não gasta a cota; o backtest válido seguinte → 200", async () => {
      const T = await (ctx.t as TestApp).seedTenant({ name: "Cota 422", monthlyQuota: 1 });
      const bad = await create(T, { kind: "buy_hold", symbol: "ZZZZ3" });
      const good = await create(T);
      await post(`${BASE}/${bad.id}/backtest`, {}, T.keys.builder).expect(422);
      await post(`${BASE}/${good.id}/backtest`, {}, T.keys.builder).expect(200);
      expect((await backtests(T)).count).toBe(1);
    });
  });

  it("limite de 100 estratégias por tenant → 422 na 101ª", async () => {
    const T = await (ctx.t as TestApp).seedTenant({ name: "Limite" });
    for (let i = 0; i < 100; i++) {
      await post(BASE, { name: `e${String(i)}`, spec: HOLD }, T.keys.builder).expect(201);
    }
    await post(BASE, { name: "e100", spec: HOLD }, T.keys.builder).expect(422);
  }, 120_000);
});

describe("Builder E2E (provedor falhando)", () => {
  const failing = () => Promise.reject(new MarketDataUnavailableError());
  const { ctx, post, backtests, create } = setup({
    overrides: [
      { token: MARKET_DATA_PROVIDER, useValue: { fetchQuotes: failing, fetchHistory: failing } },
    ],
  });

  it("provedor fora → 502 sem cobrança e sem gastar cota", async () => {
    const A = ctx.A as SeededTenant;
    const s = await create(A);
    const res = await post(`${BASE}/${s.id}/backtest`, {}, A.keys.builder);
    expect(res.status).toBe(502);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect((await backtests(A)).count).toBe(0);
  });
});

describe("Builder E2E (orçamento de chamadas ao provedor esgotado)", () => {
  const { ctx, post, backtests, create } = setup({
    env: { MARKET_PROVIDER_MAX_CALLS_PER_MIN: "1" },
  });

  it("503 com Retry-After sem cobrança; histórico em cache segue 200", async () => {
    const A = ctx.A as SeededTenant;
    const first = await create(A, HOLD);
    const other = await create(A, { kind: "buy_hold", symbol: "VALE3" });
    await post(`${BASE}/${first.id}/backtest`, {}, A.keys.builder).expect(200);
    const before = (await backtests(A)).count;
    const res = await post(`${BASE}/${other.id}/backtest`, {}, A.keys.builder);
    expect(res.status).toBe(503);
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect((await backtests(A)).count).toBe(before);
    await post(`${BASE}/${first.id}/backtest`, {}, A.keys.builder).expect(200);
  });
});
