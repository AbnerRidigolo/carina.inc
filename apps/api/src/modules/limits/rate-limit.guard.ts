/**
 * Limite por minuto por tenant (janela deslizante de 60 s no Redis, limite = `AuthTenant.rpm`).
 *
 * Roda DEPOIS do ApiKeyGuard: lê `req.tenant`. Rotas `@Public()` passam sem limite. Rota protegida
 * sem `req.tenant` significa guards fora de ordem; falha fechada (401) em vez de deixar passar
 * sem limite.
 */
import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Redis } from "ioredis";
import { RateLimitedError, UnauthenticatedError } from "../../core/errors/domain-errors.js";
import { REDIS } from "../../core/redis/redis.tokens.js";
import type { AuthenticatedRequest } from "../tenancy/api-key.guard.js";
import { IS_PUBLIC_KEY } from "../tenancy/scopes.decorator.js";
import { CLOCK, type Clock } from "./clock.js";
import { slidingWindowAcquire } from "./sliding-window.lua.js";

export const RATE_LIMIT_WINDOW_MS = 60_000;

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(REDIS) private readonly redis: Pick<Redis, "eval">,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets)) return true;
    // Mesma fronteira do ApiKeyGuard: só HTTP é limitado aqui (outro transporte já falhou lá).
    if (context.getType() !== "http") return true;

    const tenant = context.switchToHttp().getRequest<AuthenticatedRequest>().tenant;
    if (!tenant) throw new UnauthenticatedError("Chave de API ausente ou inválida");

    const { allowed, retryAfterMs } = await slidingWindowAcquire(
      this.redis,
      `rl:${tenant.tenantId}`,
      tenant.rpm,
      RATE_LIMIT_WINDOW_MS,
      this.clock(),
    );
    if (!allowed) {
      throw new RateLimitedError(
        "Limite de requisições por minuto excedido",
        Math.max(1, Math.ceil(retryAfterMs / 1000)),
      );
    }
    return true;
  }
}
