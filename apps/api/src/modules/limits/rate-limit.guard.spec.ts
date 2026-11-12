import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { RateLimitedError, UnauthenticatedError } from "../../core/errors/domain-errors.js";
import type { AuthTenant, AuthenticatedRequest } from "../tenancy/api-key.guard.js";
import { Public } from "../tenancy/scopes.decorator.js";
import { RateLimitGuard } from "./rate-limit.guard.js";

class Handlers {
  chat(): void {}
  @Public()
  open(): void {}
}

const tenant: AuthTenant = {
  keyId: "k",
  tenantId: "t-1",
  tenantName: "T",
  scopes: ["chat"],
  rpm: 7,
  monthlyQuota: 0,
};

function ctx(req: AuthenticatedRequest, handler: () => void, type = "http"): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => Handlers,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/** Redis falso: devolve a resposta do script Lua e registra os argumentos do EVAL. */
function fakeRedis(reply: number) {
  const evalFn = vi.fn<(...args: unknown[]) => Promise<number>>(() => Promise.resolve(reply));
  return { redis: { eval: evalFn } as never, evalFn };
}

describe("RateLimitGuard", () => {
  const now = 1_700_000_000_000;
  const chat = Handlers.prototype.chat;

  it("usa rl:<tenantId>, janela de 60000 ms e o rpm do tenant", async () => {
    const { redis, evalFn } = fakeRedis(0);
    const guard = new RateLimitGuard(redis, new Reflector(), () => now);
    await expect(guard.canActivate(ctx({ headers: {}, tenant }, chat))).resolves.toBe(true);
    const args = evalFn.mock.calls[0] ?? [];
    expect(args[1]).toBe(1);
    expect(args[2]).toBe(`rl:${tenant.tenantId}`);
    expect(args.slice(3, 6)).toEqual([String(now), "60000", "7"]);
  });

  it("excedido: RateLimitedError com retryAfterSeconds = ceil(ms/1000), mínimo 1", async () => {
    for (const [ms, seconds] of [
      [1, 1],
      [999, 1],
      [1000, 1],
      [1001, 2],
      [59_700, 60],
    ] as const) {
      const { redis } = fakeRedis(ms);
      const guard = new RateLimitGuard(redis, new Reflector(), () => now);
      const err = await guard
        .canActivate(ctx({ headers: {}, tenant }, chat))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).retryAfterSeconds).toBe(seconds);
    }
  });

  it("@Public(): libera sem tocar no Redis", async () => {
    const { redis, evalFn } = fakeRedis(0);
    const guard = new RateLimitGuard(redis, new Reflector(), () => now);
    await expect(guard.canActivate(ctx({ headers: {} }, Handlers.prototype.open))).resolves.toBe(
      true,
    );
    expect(evalFn).not.toHaveBeenCalled();
  });

  it("rota protegida sem req.tenant (guard fora de ordem): falha fechada com 401", async () => {
    const { redis, evalFn } = fakeRedis(0);
    const guard = new RateLimitGuard(redis, new Reflector(), () => now);
    await expect(guard.canActivate(ctx({ headers: {} }, chat))).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    expect(evalFn).not.toHaveBeenCalled();
  });
});
