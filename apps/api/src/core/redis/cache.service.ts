import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "./redis.tokens.js";

@Injectable()
export class CacheService {
  constructor(@Inject(REDIS) private readonly redis: Pick<Redis, "get" | "set">) {}

  /** Devolve o valor em cache (JSON) ou carrega, grava com TTL e devolve. */
  async getOrSet<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const hit = await this.redis.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
    const value = await load();
    const json = JSON.stringify(value);
    if (json !== undefined) await this.redis.set(key, json, "EX", ttlSeconds);
    return value;
  }
}
