/**
 * Cota mensal por tenant: contador `quota:<tenantId>:<YYYY-MM>` (mês em America/Sao_Paulo).
 *
 * `reserve` é um único EVAL (INCR, EXPIRE, compara e, se passou da cota, DECR de volta), então
 * chamadas concorrentes nunca deixam passar mais que a cota, o contador nunca fica inflado e uma
 * falha do Redis não deixa rollback pela metade. Cota 0 = ilimitada:
 * nem toca no Redis. `refund` devolve uma reserva, mas nunca leva o contador abaixo de 0.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { QuotaExceededError } from "../../core/errors/domain-errors.js";
import { REDIS } from "../../core/redis/redis.tokens.js";
import type { AuthTenant } from "../tenancy/api-key.guard.js";
import { CLOCK, type Clock } from "./clock.js";
import { type LocalTime, localTime } from "./month.js";

const KEY_TTL_SECONDS = 40 * 24 * 60 * 60;

/**
 * Reserva atômica: INCR + EXPIRE; se passou da cota, DECR de volta (no mesmo script, então o
 * valor acima da cota nunca é visível a outro comando) e devolve 0; senão devolve 1.
 * KEYS[1] = chave; ARGV = cota, TTL em segundos.
 */
const RESERVE_LUA = `
local used = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
if used > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
`;

/** DECR só se o valor for > 0 (o refund não pode deixar o contador negativo). */
const SAFE_DECR_LUA = `
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
if v > 0 then
  return redis.call('DECR', KEYS[1])
end
return 0
`;

@Injectable()
export class QuotaService {
  constructor(
    @Inject(REDIS) private readonly redis: Pick<Redis, "eval">,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private key(tenantId: string, t: LocalTime): string {
    return `quota:${tenantId}:${t.year}-${String(t.month).padStart(2, "0")}`;
  }

  /** Reserva uma unidade da cota do mês; `QuotaExceededError` (429 + Retry-After) se esgotada. */
  async reserve(tenant: AuthTenant): Promise<void> {
    if (tenant.monthlyQuota <= 0) return;
    const now = this.clock();
    const t = localTime(now);
    const key = this.key(tenant.tenantId, t);

    // Um único EVAL: ninguém observa o contador acima da cota nem o vê inflado se o processo cair.
    const reply = await this.redis.eval(
      RESERVE_LUA,
      1,
      key,
      String(tenant.monthlyQuota),
      String(KEY_TTL_SECONDS),
    );
    if (Number(reply) !== 1) {
      throw new QuotaExceededError(
        "Cota mensal esgotada",
        Math.max(1, Math.ceil((t.nextMonthStartMs - now) / 1000)),
      );
    }
  }

  /** Devolve uma reserva (ex.: a operação falhou antes de consumir); o contador nunca fica < 0. */
  async refund(tenant: AuthTenant): Promise<void> {
    if (tenant.monthlyQuota <= 0) return;
    const key = this.key(tenant.tenantId, localTime(this.clock()));
    await this.redis.eval(SAFE_DECR_LUA, 1, key);
  }
}
