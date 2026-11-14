/**
 * LockService: lock distribuído no Redis (SET NX PX + token), com heartbeat (compare-and-pexpire)
 * e liberação compare-and-del. DB lógico próprio (test/setup/redis-dbs.ts), esvaziado a cada teste.
 */
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockLostError, LockService } from "../../src/core/redis/lock.service.js";
import { redisDbUrl } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

const TEST_DB = redisDbOf("redis/lock.int.spec.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("LockService", () => {
  let redis: Redis;
  let locks: LockService;

  beforeEach(async () => {
    redis = new Redis(redisDbUrl(TEST_DB));
    await redis.flushdb();
    locks = new LockService(redis);
  });

  afterEach(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  it("exclusão mútua: a segunda aquisição da mesma chave falha; outra chave não é afetada", async () => {
    const a = await locks.acquire("k1", 5000);
    expect(a).not.toBeNull();
    expect(await locks.acquire("k1", 5000)).toBeNull();
    const other = await locks.acquire("k2", 5000);
    expect(other).not.toBeNull();
    expect(await a?.release()).toBe(true);
    const again = await locks.acquire("k1", 5000);
    expect(again).not.toBeNull();
    await again?.release();
    await other?.release();
  });

  it("o heartbeat mantém o lock vivo além de um TTL", async () => {
    const h = await locks.acquire("hb", 300);
    expect(h).not.toBeNull();
    await sleep(1000); // mais de 3 TTLs
    expect(h?.lost).toBe(false);
    await expect(h?.assertHeld()).resolves.toBeUndefined();
    expect(await redis.get("hb")).toBe(h?.token);
    expect(await h?.release()).toBe(true);
    expect(await redis.exists("hb")).toBe(0);
  });

  it("dono que morreu (sem heartbeat nem release): o TTL expira e outro worker adquire", async () => {
    const dead = await locks.acquire("crash", 200, { heartbeat: false });
    expect(dead).not.toBeNull();
    expect(await locks.acquire("crash", 200)).toBeNull();
    await sleep(350);
    const next = await locks.acquire("crash", 5000);
    expect(next).not.toBeNull();

    // o dono antigo (token diferente) não renova nem apaga o lock do novo dono
    expect(await dead?.renew()).toBe(false);
    expect(await dead?.release()).toBe(false);
    await expect(dead?.assertHeld()).rejects.toBeInstanceOf(LockLostError);
    expect(dead?.lost).toBe(true);
    expect(await redis.get("crash")).toBe(next?.token);
    expect(await redis.pttl("crash")).toBeGreaterThan(1000);
    await next?.release();
  });

  it("o heartbeat percebe a perda do lock e marca `lost`", async () => {
    const h = await locks.acquire("steal", 300);
    await redis.set("steal", "outro-token", "PX", 5000);
    await sleep(250); // pelo menos um heartbeat (ttl/3)
    expect(h?.lost).toBe(true);
    await expect(h?.assertHeld()).rejects.toBeInstanceOf(LockLostError);
    expect(await h?.release()).toBe(false);
    expect(await redis.get("steal")).toBe("outro-token");
  });

  it("release é idempotente e para o heartbeat", async () => {
    const h = await locks.acquire("idem", 300);
    expect(await h?.release()).toBe(true);
    expect(await h?.release()).toBe(false);
    // sem heartbeat depois do release: uma nova aquisição não é renovada pelo antigo
    const n = await locks.acquire("idem", 300, { heartbeat: false });
    expect(n).not.toBeNull();
    await sleep(450);
    expect(await redis.exists("idem")).toBe(0);
  });

  it("valida o TTL", async () => {
    await expect(locks.acquire("x", 0)).rejects.toBeInstanceOf(RangeError);
    await expect(locks.acquire("x", 1.5)).rejects.toBeInstanceOf(RangeError);
  });
});
