import { ProblemSchema } from "@carina/shared";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QuotaExceededError } from "../../src/core/errors/domain-errors.js";
import { CLOCK } from "../../src/modules/limits/clock.js";
import { LimitsModule } from "../../src/modules/limits/limits.module.js";
import { QuotaService } from "../../src/modules/limits/quota.service.js";
import { slidingWindowAcquire } from "../../src/modules/limits/sliding-window.lua.js";
import type { AuthTenant } from "../../src/modules/tenancy/api-key.guard.js";
import { createTestApp, type TestApp } from "../setup/app.js";
import { redisDbUrl } from "../setup/db.js";

// DB lógico dedicado a este arquivo (os demais arquivos de teste usam outros); esvaziado a cada teste.
const TEST_DB = 12;

const TENANT_ID = "6f1c1d1e-8a3b-4c2d-9e0f-0123456789ab";

function tenant(over: Partial<AuthTenant> = {}): AuthTenant {
  return {
    keyId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    tenantId: TENANT_ID,
    tenantName: "T",
    scopes: ["chat"],
    rpm: 60,
    monthlyQuota: 0,
    ...over,
  };
}

describe("slidingWindowAcquire", () => {
  let redis: Redis;

  beforeEach(async () => {
    redis = new Redis(redisDbUrl(TEST_DB));
    await redis.flushdb();
  });
  afterEach(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  it("libera até o limite e depois recusa com o tempo até o mais antigo sair da janela", async () => {
    const t0 = 1_000_000;
    expect(await slidingWindowAcquire(redis, "k", 2, 60_000, t0)).toEqual({
      allowed: true,
      retryAfterMs: 0,
    });
    expect((await slidingWindowAcquire(redis, "k", 2, 60_000, t0 + 10_000)).allowed).toBe(true);
    const denied = await slidingWindowAcquire(redis, "k", 2, 60_000, t0 + 20_000);
    expect(denied).toEqual({ allowed: false, retryAfterMs: 40_000 });
    // O mais antigo (t0) sai da janela em t0 + 60000.
    expect((await slidingWindowAcquire(redis, "k", 2, 60_000, t0 + 60_000)).allowed).toBe(true);
  });

  it("requisições no mesmo milissegundo não colapsam num só membro do ZSET", async () => {
    const now = 5_000_000;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => slidingWindowAcquire(redis, "same-ms", 5, 60_000, now)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(await redis.zcard("same-ms")).toBe(5);
  });

  it("define o TTL da chave (PEXPIRE) igual à janela", async () => {
    await slidingWindowAcquire(redis, "ttl", 5, 60_000, Date.now());
    const ttl = await redis.pttl("ttl");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it("retryAfterMs nunca é 0 numa recusa (limite 0)", async () => {
    const r = await slidingWindowAcquire(redis, "zero", 0, 60_000, 1_000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThanOrEqual(1);
  });
});

describe("RateLimitGuard (HTTP)", () => {
  let t: TestApp;
  let server: Parameters<typeof request>[0];
  let now = Date.UTC(2026, 5, 15, 12, 0, 0);
  let redis: Redis;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [LimitsModule],
      overrides: [{ token: CLOCK, useValue: () => now }],
      redisDb: TEST_DB,
    });
    server = t.app.getHttpServer() as Parameters<typeof request>[0];
    redis = new Redis(redisDbUrl(TEST_DB));
  });
  afterAll(async () => {
    await t?.close();
    await redis?.flushdb();
    redis?.disconnect();
  });

  it("com rpm 3, a 4ª requisição recebe 429 com Retry-After >= 1 e passa de novo após avançar o relógio", async () => {
    const { keys } = await t.seedTenant({ rpm: 3 });
    const get = () =>
      request(server).get("/api/clients").set("Authorization", `Bearer ${keys.chat}`);

    for (let i = 0; i < 3; i++) {
      await get().expect(200);
      now += 100;
    }
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(ProblemSchema.parse(res.body).type).toMatch(/rate_limited$/);
    const retryAfter = Number(res.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    // O mais antigo entrou 300 ms antes: faltam 59,7 s → 60 s.
    expect(retryAfter).toBe(60);

    now += 60_000;
    await get().expect(200);
  });

  it("o limite é por tenant: um tenant esgotado não afeta outro", async () => {
    const a = await t.seedTenant({ rpm: 1 });
    const b = await t.seedTenant({ rpm: 1 });
    const get = (key: string) => request(server).get("/api/clients").set("X-API-Key", key);
    await get(a.keys.chat).expect(200);
    await get(a.keys.chat).expect(429);
    await get(b.keys.chat).expect(200);
  });

  it("o 429 sempre traz Retry-After (taxa e cota)", async () => {
    const { keys } = await t.seedTenant({ rpm: 1 });
    await request(server).get("/api/clients").set("X-API-Key", keys.chat).expect(200);
    const res = await request(server).get("/api/clients").set("X-API-Key", keys.chat);
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toMatch(/^[1-9]\d*$/);
  });

  it("rota autenticada sem permissão de escopo (403) não consome a janela do tenant", async () => {
    const { keys } = await t.seedTenant({ rpm: 1 });
    // ApiKeyGuard lança 403 antes: o RateLimitGuard nem roda.
    await request(server).get("/api/clients").set("X-API-Key", keys.ingest).expect(403);
    await request(server).get("/api/clients").set("X-API-Key", keys.chat).expect(200);
  });
});

describe("QuotaService", () => {
  let redis: Redis;
  let svc: QuotaService;
  let now: number;

  beforeEach(async () => {
    redis = new Redis(redisDbUrl(TEST_DB));
    await redis.flushdb();
    now = Date.UTC(2026, 5, 15, 12, 0, 0); // 15/06/2026 09:00 em São Paulo
    svc = new QuotaService(redis, () => now);
  });
  afterEach(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  const key = (month: string) => `quota:${TENANT_ID}:${month}`;

  it("50 reserve concorrentes com cota 10 resultam em exatamente 10 sucessos", async () => {
    const tn = tenant({ monthlyQuota: 10 });
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => svc.reserve(tn)));
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(10);
    expect(failed).toHaveLength(40);
    for (const f of failed) {
      expect(f.reason).toBeInstanceOf(QuotaExceededError);
      expect((f.reason as QuotaExceededError).retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
    // As recusas devolveram o que incrementaram: o contador fica no limite.
    expect(await redis.get(key("2026-06"))).toBe("10");
  });

  it("retryAfterSeconds vai até o início do próximo mês (America/Sao_Paulo)", async () => {
    // 30/06/2026 23:59:00 em São Paulo (UTC-3) = 01/07 02:59:00 UTC → faltam 60 s.
    now = Date.UTC(2026, 6, 1, 2, 59, 0);
    const tn = tenant({ monthlyQuota: 1 });
    await svc.reserve(tn);
    const err = await svc.reserve(tn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect((err as QuotaExceededError).retryAfterSeconds).toBe(60);
    expect(await redis.get(key("2026-06"))).toBe("1");
  });

  it("o mês da chave segue o fuso America/Sao_Paulo, não UTC", async () => {
    const tn = tenant({ monthlyQuota: 5 });
    now = Date.UTC(2026, 6, 1, 2, 59, 59); // ainda 30/06 em São Paulo
    await svc.reserve(tn);
    now = Date.UTC(2026, 6, 1, 3, 0, 0); // 01/07 00:00 em São Paulo
    await svc.reserve(tn);
    expect(await redis.get(key("2026-06"))).toBe("1");
    expect(await redis.get(key("2026-07"))).toBe("1");
  });

  it("a chave expira em 40 dias", async () => {
    await svc.reserve(tenant({ monthlyQuota: 5 }));
    const ttl = await redis.ttl(key("2026-06"));
    expect(ttl).toBeGreaterThan(40 * 86400 - 5);
    expect(ttl).toBeLessThanOrEqual(40 * 86400);
  });

  it("reserve seguido de refund deixa o contador em 0", async () => {
    const tn = tenant({ monthlyQuota: 5 });
    await svc.reserve(tn);
    await svc.refund(tn);
    expect(await redis.get(key("2026-06"))).toBe("0");
  });

  it("refund nunca leva o contador abaixo de 0", async () => {
    const tn = tenant({ monthlyQuota: 5 });
    await svc.refund(tn); // chave inexistente
    expect(Number((await redis.get(key("2026-06"))) ?? 0)).toBe(0);
    await svc.reserve(tn);
    await Promise.all([svc.refund(tn), svc.refund(tn), svc.refund(tn)]);
    expect(Number((await redis.get(key("2026-06"))) ?? 0)).toBe(0);
  });

  it("reserve recusada, refund e reserve na sequência: a recusa não infla o contador (corrida INCR/DECR)", async () => {
    const tn = tenant({ monthlyQuota: 10 });
    for (let i = 0; i < 10; i++) await svc.reserve(tn);
    // Disparadas no mesmo tick: o Redis as processa nesta ordem. Serialmente: A recusada (10 usados),
    // refund (9), B passa (10). Com INCR+DECR separados, A levava o contador a 11 e B era recusada.
    const [a, , b] = await Promise.allSettled([svc.reserve(tn), svc.refund(tn), svc.reserve(tn)]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("fulfilled");
    expect(await redis.get(key("2026-06"))).toBe("10");
  });

  it("sequências aleatórias de reserve/refund concorrentes seguem o modelo serial (nunca inflado nem negativo)", async () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const limit = 5;
    const tn = tenant({ monthlyQuota: limit });
    for (let round = 0; round < 20; round++) {
      await redis.flushdb();
      let model = 0;
      const ops: ("reserve" | "refund")[] = [];
      const expected: boolean[] = [];
      for (let i = 0; i < 40; i++) {
        const op = rand() < 0.55 ? "reserve" : "refund";
        ops.push(op);
        if (op === "reserve") {
          const ok = model < limit;
          if (ok) model++;
          expected.push(ok);
        } else {
          if (model > 0) model--;
          expected.push(true);
        }
      }
      const results = await Promise.allSettled(
        ops.map((op) => (op === "reserve" ? svc.reserve(tn) : svc.refund(tn))),
      );
      expect(results.map((r) => r.status === "fulfilled")).toEqual(expected);
      expect(Number((await redis.get(key("2026-06"))) ?? 0)).toBe(model);
    }
  });

  it("falha do Redis ao executar o script não deixa o contador inflado e o erro aparece", async () => {
    const blip = new Error("blip no EVAL");
    let calls = 0;
    const flaky = {
      eval: (...args: Parameters<Redis["eval"]>) => {
        if (calls++ === 0) return Promise.reject(blip);
        return redis.eval(...args);
      },
    } as unknown as ConstructorParameters<typeof QuotaService>[0];
    const flakySvc = new QuotaService(flaky, () => now);
    const tn = tenant({ monthlyQuota: 3 });
    await expect(flakySvc.reserve(tn)).rejects.toBe(blip);
    expect(Number((await redis.get(key("2026-06"))) ?? 0)).toBe(0);
    for (let i = 0; i < 3; i++) await flakySvc.reserve(tn);
    await expect(flakySvc.reserve(tn)).rejects.toBeInstanceOf(QuotaExceededError);
    expect(await redis.get(key("2026-06"))).toBe("3");
  });

  it("cota 0 é ilimitada: nunca bloqueia e nunca grava no Redis", async () => {
    const tn = tenant({ monthlyQuota: 0 });
    await Promise.all(Array.from({ length: 100 }, () => svc.reserve(tn)));
    await svc.refund(tn);
    expect(await redis.keys("quota:*")).toEqual([]);
  });
});
