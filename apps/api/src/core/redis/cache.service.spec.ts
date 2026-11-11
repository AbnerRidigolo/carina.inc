import { describe, expect, it, vi } from "vitest";
import { CacheService } from "./cache.service.js";

function fakeRedis() {
  const store = new Map<string, { value: string; ttl: number }>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k)?.value ?? null),
    set: vi.fn(async (k: string, v: string, _ex: "EX", ttl: number) => {
      store.set(k, { value: v, ttl });
      return "OK" as const;
    }),
  };
}

describe("CacheService.getOrSet", () => {
  it("carrega no miss, grava com TTL e serve o hit sem recarregar", async () => {
    const redis = fakeRedis();
    const cache = new CacheService(redis as never);
    const load = vi.fn(async () => ({ a: 1 }));
    expect(await cache.getOrSet("k", 30, load)).toEqual({ a: 1 });
    expect(await cache.getOrSet("k", 30, load)).toEqual({ a: 1 });
    expect(load).toHaveBeenCalledTimes(1);
    expect(redis.store.get("k")).toEqual({ value: '{"a":1}', ttl: 30 });
  });

  it("propaga erro do loader sem gravar nada", async () => {
    const redis = fakeRedis();
    const cache = new CacheService(redis as never);
    await expect(
      cache.getOrSet("k", 30, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(redis.store.size).toBe(0);
  });

  it("cacheia valores null", async () => {
    const redis = fakeRedis();
    const cache = new CacheService(redis as never);
    const load = vi.fn(async () => null);
    await cache.getOrSet("k", 5, load);
    await cache.getOrSet("k", 5, load);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
