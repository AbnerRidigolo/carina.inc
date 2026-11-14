import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV, MODELS_CONFIG } from "../../src/core/config/config.module.js";
import type { ModelsConfig } from "../../src/core/config/models-config.js";
import { CLOCK } from "../../src/modules/limits/clock.js";
import { LlmModule } from "../../src/modules/llm/llm.module.js";
import { MockChatModel } from "../../src/modules/llm/mock-models.js";
import { ModelFactory } from "../../src/modules/llm/model-factory.js";
import {
  PROVIDER_WINDOW_MS,
  ProviderLimiter,
  ProviderRateLimitedError,
} from "../../src/modules/llm/provider-limiter.js";
import { createTestApp } from "../setup/app.js";
import { redisDbUrl } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

// DB lógico próprio (test/setup/redis-dbs.ts); esvaziado a cada teste.
const TEST_DB = redisDbOf("llm/provider-limiter.int.spec.ts");

const silent = () => ({ warn: vi.fn(), error: vi.fn() });

describe("ProviderLimiter (Redis real)", () => {
  let redis: Redis;
  let now: number;
  const clock = () => now;

  beforeEach(async () => {
    redis = new Redis(redisDbUrl(TEST_DB));
    await redis.flushdb();
    now = 1_700_000_000_000;
  });
  afterEach(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  it("libera rpm chamadas por minuto na chave llm:rl:<provedor> e recusa a seguinte", async () => {
    const limiter = new ProviderLimiter(redis, 2, clock, silent());
    await limiter.acquire("openrouter");
    now += 10_000;
    await limiter.acquire("openrouter");
    now += 10_000;
    const err = await limiter.acquire("openrouter").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRateLimitedError);
    // O mais antigo sai da janela 40 s depois.
    expect((err as ProviderRateLimitedError).retryAfterMs).toBe(40_000);
    expect(await redis.zcard("llm:rl:openrouter")).toBe(2);
    // Outro provedor tem a própria janela.
    await limiter.acquire("groq");
    expect(await redis.zcard("llm:rl:groq")).toBe(1);
  });

  it("a janela desliza com o relógio", async () => {
    const limiter = new ProviderLimiter(redis, 1, clock, silent());
    await limiter.acquire("groq");
    await expect(limiter.acquire("groq")).rejects.toBeInstanceOf(ProviderRateLimitedError);
    now += PROVIDER_WINDOW_MS;
    await expect(limiter.acquire("groq")).resolves.toBeUndefined();
  });

  it("relógio desta instância atrasado em relação às outras: retry nunca passa da janela", async () => {
    const limiter = new ProviderLimiter(redis, 1, clock, silent());
    // Outra instância, com relógio 5 min adiantado, ocupou a vaga.
    now += 5 * 60_000;
    await limiter.acquire("openrouter");
    now -= 5 * 60_000;
    const err = await limiter.acquire("openrouter").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRateLimitedError);
    expect((err as ProviderRateLimitedError).retryAfterMs).toBe(PROVIDER_WINDOW_MS);
  });

  it("chamadas concorrentes nunca passam do rpm", async () => {
    const limiter = new ProviderLimiter(redis, 5, clock, silent());
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => limiter.acquire("openrouter")),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
  });
});

describe("LlmModule (Nest, modo mock)", () => {
  it("resolve a ModelFactory no modo mock com o models.yaml real", async () => {
    const t = await createTestApp({ imports: [LlmModule], redisDb: TEST_DB });
    try {
      const factory = t.app.get(ModelFactory);
      const cfg = t.app.get<ModelsConfig>(MODELS_CONFIG);
      expect(cfg.limits.rpm).toBe(20);
      expect(t.app.get<{ LLM_MODE: string }>(ENV).LLM_MODE).toBe("mock");
      const model = factory.chat("conversational");
      expect(model).toBeInstanceOf(MockChatModel);
      const out = (await model.invoke([new HumanMessage("oi")])) as AIMessage;
      expect(typeof out.content).toBe("string");
      expect(typeof t.app.get(CLOCK)).toBe("function");
    } finally {
      await t.close();
    }
  });
});
