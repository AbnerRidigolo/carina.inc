import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

/**
 * Janela deslizante em ZSET, tudo num único EVAL (atômico no Redis):
 * 1. remove os membros fora da janela (score <= now - window);
 * 2. se ZCARD < limit: ZADD now member + PEXPIRE window e devolve 0;
 * 3. senão devolve (score do mais antigo + window - now) em ms, sempre >= 1.
 *
 * KEYS[1] = chave; ARGV = now, window, limit, member (único por requisição).
 */
export const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
if redis.call('ZCARD', key) < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return 0
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
if oldest[2] == nil then
  return window
end
local retry = tonumber(oldest[2]) + window - now
if retry < 1 then
  retry = 1
end
return retry
`;

export interface SlidingWindowResult {
  allowed: boolean;
  /** 0 quando liberado; senão, ms até o mais antigo sair da janela (>= 1). */
  retryAfterMs: number;
}

/**
 * Genérico (sem Nest nem tenant): reutilizado pelo limitador de provedores de LLM.
 * O membro do ZSET é `<nowMs>-<aleatório>`, para requisições no mesmo milissegundo não colapsarem
 * num único membro.
 */
export async function slidingWindowAcquire(
  redis: Pick<Redis, "eval">,
  key: string,
  limit: number,
  windowMs: number,
  nowMs: number,
): Promise<SlidingWindowResult> {
  const member = `${nowMs}-${randomBytes(8).toString("hex")}`;
  const reply = await redis.eval(
    SLIDING_WINDOW_LUA,
    1,
    key,
    String(nowMs),
    String(windowMs),
    String(limit),
    member,
  );
  const retryAfterMs = Number(reply);
  return { allowed: retryAfterMs === 0, retryAfterMs };
}
