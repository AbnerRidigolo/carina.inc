/**
 * Lock distribuído simples no Redis (uma instância), para serializar trabalho entre réplicas.
 *
 * - Aquisição: `SET key token NX PX ttl`, com `token` aleatório por aquisição.
 * - Heartbeat: a cada `ttl/3`, renova com compare-and-pexpire (Lua: só renova se o valor ainda é
 *   o token). Se a renovação falha (expirou ou outro dono), o handle fica `lost` e o heartbeat
 *   para. O timer é `unref()`: nunca segura o processo vivo.
 * - Liberação: compare-and-del (Lua): um dono antigo cujo token não bate não apaga o lock do novo.
 * - Recuperação: se o dono morre sem liberar, o heartbeat morre junto e a chave expira em `ttl`;
 *   depois disso outro worker adquire.
 * - `assertHeld()` renova na hora e lança `LockLostError` se o lock não é mais deste dono: quem
 *   segura o lock chama antes de cada efeito colateral (ex.: escrita) para não agir como
 *   "fantasma" depois de perder o lock.
 */
import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "./redis.tokens.js";

const RENEW_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

/** O lock expirou ou passou a outro dono. Erro transitório: quem tentava pode tentar de novo. */
export class LockLostError extends Error {
  constructor(readonly key: string) {
    super(`Lock ${key} perdido (expirou ou passou a outro dono)`);
    this.name = "LockLostError";
  }
}

export interface LockHandle {
  readonly key: string;
  readonly token: string;
  /** O heartbeat ou uma renovação percebeu que o lock não é mais deste dono. */
  readonly lost: boolean;
  /** Renova agora; `false` (e `lost`) se o lock não é mais deste dono. */
  renew(): Promise<boolean>;
  /** Renova agora e lança `LockLostError` se o lock foi perdido. */
  assertHeld(): Promise<void>;
  /** Para o heartbeat e apaga a chave se ainda for deste dono. Idempotente. */
  release(): Promise<boolean>;
}

export interface AcquireOptions {
  /** Renovação automática a cada ttl/3 (padrão true). `false` simula um dono que morreu. */
  heartbeat?: boolean;
}

class RedisLockHandle implements LockHandle {
  private timer: NodeJS.Timeout | undefined;
  private released = false;
  lost = false;

  constructor(
    private readonly redis: Redis,
    readonly key: string,
    readonly token: string,
    private readonly ttlMs: number,
    heartbeat: boolean,
  ) {
    if (heartbeat) {
      this.timer = setInterval(
        () => {
          // Erro de rede no heartbeat não marca `lost`: a próxima renovação (ou o assertHeld)
          // decide; se o Redis não voltar antes do TTL, a renovação seguinte falha.
          this.renew().catch(() => undefined);
        },
        Math.max(1, Math.floor(ttlMs / 3)),
      );
      this.timer.unref();
    }
  }

  async renew(): Promise<boolean> {
    if (this.released || this.lost) return false;
    const ok = (await this.redis.eval(RENEW_LUA, 1, this.key, this.token, this.ttlMs)) === 1;
    if (!ok) {
      this.lost = true;
      this.stop();
    }
    return ok;
  }

  async assertHeld(): Promise<void> {
    if (!(await this.renew())) throw new LockLostError(this.key);
  }

  async release(): Promise<boolean> {
    this.stop();
    if (this.released) return false;
    this.released = true;
    return (await this.redis.eval(RELEASE_LUA, 1, this.key, this.token)) === 1;
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

@Injectable()
export class LockService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Tenta adquirir; `null` se a chave já tem dono. */
  async acquire(key: string, ttlMs: number, opts: AcquireOptions = {}): Promise<LockHandle | null> {
    if (!Number.isInteger(ttlMs) || ttlMs < 1) {
      throw new RangeError("ttlMs precisa ser um inteiro positivo");
    }
    const token = randomBytes(16).toString("hex");
    const ok = await this.redis.set(key, token, "PX", ttlMs, "NX");
    if (ok !== "OK") return null;
    return new RedisLockHandle(this.redis, key, token, ttlMs, opts.heartbeat ?? true);
  }
}
