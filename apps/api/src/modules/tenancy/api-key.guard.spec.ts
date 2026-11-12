import "reflect-metadata";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { firstValueFrom, from, lastValueFrom, toArray } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { TenantContext } from "../../core/context/tenant-context.js";
import type { PrismaService } from "../../core/database/prisma.service.js";
import { ForbiddenScopeError, UnauthenticatedError } from "../../core/errors/domain-errors.js";
import { hashApiKey } from "./api-key.js";
import {
  ApiKeyGuard,
  TenantContextInterceptor,
  type AuthTenant,
  type AuthenticatedRequest,
} from "./api-key.guard.js";
import { Public, RequireAnyScope, RequireScopes } from "./scopes.decorator.js";

const TENANT_ID = "6f1c1d1e-8a3b-4c2d-9e0f-0123456789ab";
const KEY_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const KEY = "sk-live-0123456789ABCDEFGHIJabcdefghijKL";

class Handlers {
  @RequireScopes("chat")
  chat(): void {}

  @RequireScopes("chat", "inbox:decide")
  decide(): void {}

  @RequireAnyScope("chat", "inbox:decide")
  either(): void {}

  @RequireAnyScope()
  emptyAny(): void {}

  noScopes(): void {}

  @Public()
  open(): void {}
}

@Public()
class PublicController {
  anything(): void {}
}

interface Row {
  key_id: string;
  tenant_id: string;
  tenant_name: string;
  scopes: string[] | null;
  rpm: number;
  monthly_quota: number;
}

function row(scopes: string[] | null): Row {
  return {
    key_id: KEY_ID,
    tenant_id: TENANT_ID,
    tenant_name: "Tenant A",
    scopes,
    rpm: 60,
    monthly_quota: 0,
  };
}

/** PrismaService falso: registra os valores interpolados em cada `$queryRaw`. */
function fakePrisma(rows: Row[]) {
  const $queryRaw = vi.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>>(
    async () => rows,
  );
  return { prisma: { $queryRaw } as unknown as PrismaService, $queryRaw };
}

function httpContext(
  req: AuthenticatedRequest,
  handler: () => void,
  cls: object = Handlers,
  type = "http",
): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function req(headers: Record<string, string | string[]> = {}): AuthenticatedRequest {
  return { headers };
}

const handlers = Handlers.prototype;

describe("ApiKeyGuard", () => {
  it("sem chave: 401 sem consultar o banco", async () => {
    const { prisma, $queryRaw } = fakePrisma([row(["chat"])]);
    const guard = new ApiKeyGuard(prisma, new Reflector());
    await expect(guard.canActivate(httpContext(req(), handlers.chat))).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it("Bearer: consulta resolve_api_key com o hash (nunca a chave) e preenche req.tenant", async () => {
    const { prisma, $queryRaw } = fakePrisma([row(["chat"])]);
    const guard = new ApiKeyGuard(prisma, new Reflector());
    const r = req({ authorization: `Bearer ${KEY}` });
    await expect(guard.canActivate(httpContext(r, handlers.chat))).resolves.toBe(true);

    expect($queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = $queryRaw.mock.calls[0] ?? [];
    expect(strings?.join("?")).toMatch(/resolve_api_key\(\?\)/);
    expect(values).toEqual([hashApiKey(KEY)]);
    expect(JSON.stringify($queryRaw.mock.calls)).not.toContain(KEY);

    expect(r.tenant).toEqual<AuthTenant>({
      keyId: KEY_ID,
      tenantId: TENANT_ID,
      tenantName: "Tenant A",
      scopes: ["chat"],
      rpm: 60,
      monthlyQuota: 0,
    });
  });

  it("aceita o esquema Bearer sem diferenciar maiúsculas e o header X-API-Key", async () => {
    const { prisma, $queryRaw } = fakePrisma([row(["chat"])]);
    const guard = new ApiKeyGuard(prisma, new Reflector());
    await guard.canActivate(httpContext(req({ authorization: `bearer ${KEY}` }), handlers.chat));
    await guard.canActivate(httpContext(req({ "x-api-key": KEY }), handlers.chat));
    expect($queryRaw.mock.calls.map((c) => c[1])).toEqual([hashApiKey(KEY), hashApiKey(KEY)]);
  });

  it("chave desconhecida ou revogada (nenhuma linha) responde igual a chave ausente", async () => {
    const { prisma } = fakePrisma([]);
    const guard = new ApiKeyGuard(prisma, new Reflector());
    const unknown = await guard
      .canActivate(httpContext(req({ "x-api-key": KEY }), handlers.chat))
      .catch((e: unknown) => e);
    const missing = await guard
      .canActivate(httpContext(req(), handlers.chat))
      .catch((e: unknown) => e);
    const malformed = await guard
      .canActivate(httpContext(req({ authorization: "Basic abc" }), handlers.chat))
      .catch((e: unknown) => e);
    for (const err of [unknown, missing, malformed]) {
      expect(err).toBeInstanceOf(UnauthenticatedError);
      expect((err as Error).message).toBe((missing as Error).message);
    }
  });

  it("chave vazia, repetida ou longa demais: 401 sem consultar o banco", async () => {
    const { prisma, $queryRaw } = fakePrisma([row(["chat"])]);
    const guard = new ApiKeyGuard(prisma, new Reflector());
    const cases: Record<string, string | string[]>[] = [
      { authorization: "Bearer " },
      { authorization: "Bearer    " },
      { "x-api-key": "" },
      { "x-api-key": [KEY, KEY] },
      { "x-api-key": `sk-live-${"a".repeat(500)}` },
    ];
    for (const headers of cases) {
      await expect(
        guard.canActivate(httpContext(req(headers), handlers.chat)),
      ).rejects.toBeInstanceOf(UnauthenticatedError);
    }
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it("chave fora do formato sk-live-<32 base62>: 401 sem consultar o banco, igual a chave ausente", async () => {
    const { prisma, $queryRaw } = fakePrisma([row(["chat"])]);
    const guard = new ApiKeyGuard(prisma, new Reflector());
    const missing = await guard
      .canActivate(httpContext(req(), handlers.chat))
      .catch((e: unknown) => e);
    const body32 = "0123456789ABCDEFGHIJabcdefghijKL";
    const malformed = [
      "x",
      `sk-test-${body32}`,
      `sk-live-${body32.slice(1)}`, // 31 caracteres
      `sk-live-${body32}M`, // 33 caracteres
      `sk-live-${body32.slice(1)}-`, // caractere fora de base62
      `sk-live-${body32.slice(1)}_`,
      `SK-LIVE-${body32}`,
    ];
    for (const bad of malformed) {
      const variants: Record<string, string>[] = [
        { authorization: `Bearer ${bad}` },
        { "x-api-key": bad },
      ];
      for (const headers of variants) {
        const err = await guard
          .canActivate(httpContext(req(headers), handlers.chat))
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UnauthenticatedError);
        expect((err as Error).message).toBe((missing as Error).message);
      }
    }
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it("escopos NULL no banco viram lista vazia (sem escopos) e a rota com escopo dá 403", async () => {
    const { prisma } = fakePrisma([row(null)]);
    const guard = new ApiKeyGuard(prisma, new Reflector());
    const r = req({ "x-api-key": KEY });
    await expect(guard.canActivate(httpContext(r, handlers.chat))).rejects.toBeInstanceOf(
      ForbiddenScopeError,
    );
    expect(r.tenant?.scopes).toEqual([]);

    const r2 = req({ "x-api-key": KEY });
    await expect(guard.canActivate(httpContext(r2, handlers.noScopes))).resolves.toBe(true);
    expect(r2.tenant?.scopes).toEqual([]);
  });

  it("exige todos os escopos declarados", async () => {
    const { prisma } = fakePrisma([row(["chat"])]);
    const guard = new ApiKeyGuard(prisma, new Reflector());
    await expect(
      guard.canActivate(httpContext(req({ "x-api-key": KEY }), handlers.decide)),
    ).rejects.toBeInstanceOf(ForbiddenScopeError);

    const both = fakePrisma([row(["chat", "inbox:decide"])]);
    await expect(
      new ApiKeyGuard(both.prisma, new Reflector()).canActivate(
        httpContext(req({ "x-api-key": KEY }), handlers.decide),
      ),
    ).resolves.toBe(true);
  });

  it("@RequireAnyScope: basta um dos escopos; nenhum dá 403; lista vazia nunca autoriza", async () => {
    const check = (scopes: string[], h: () => void) =>
      new ApiKeyGuard(fakePrisma([row(scopes)]).prisma, new Reflector()).canActivate(
        httpContext(req({ "x-api-key": KEY }), h),
      );
    await expect(check(["chat"], handlers.either)).resolves.toBe(true);
    await expect(check(["inbox:decide"], handlers.either)).resolves.toBe(true);
    await expect(check(["data:write"], handlers.either)).rejects.toBeInstanceOf(
      ForbiddenScopeError,
    );
    await expect(check([], handlers.either)).rejects.toBeInstanceOf(ForbiddenScopeError);
    await expect(check(["chat", "admin"], handlers.emptyAny)).rejects.toBeInstanceOf(
      ForbiddenScopeError,
    );
  });

  it("@Public() no método ou na classe libera sem chave e sem consultar o banco", async () => {
    const { prisma, $queryRaw } = fakePrisma([]);
    const guard = new ApiKeyGuard(prisma, new Reflector());
    await expect(guard.canActivate(httpContext(req(), handlers.open))).resolves.toBe(true);
    await expect(
      guard.canActivate(httpContext(req(), PublicController.prototype.anything, PublicController)),
    ).resolves.toBe(true);
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it("contexto não HTTP sem @Public(): falha fechada (401)", async () => {
    const { prisma } = fakePrisma([row(["chat"])]);
    const guard = new ApiKeyGuard(prisma, new Reflector());
    await expect(
      guard.canActivate(httpContext(req(), handlers.noScopes, Handlers, "ws")),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe("TenantContextInterceptor", () => {
  const tenant: AuthTenant = {
    keyId: KEY_ID,
    tenantId: TENANT_ID,
    tenantName: "Tenant A",
    scopes: ["chat"],
    rpm: 60,
    monthlyQuota: 0,
  };

  /** Imita o Nest: o handler só roda quando `handle()` é chamado e o Observable é assinado. */
  function handlerOf<T>(fn: () => Promise<T>): CallHandler<T> {
    return { handle: () => from(Promise.resolve().then(fn)) };
  }

  it("o handler async (e o que ele chama depois de awaits) vê o contexto do tenant", async () => {
    const service = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return TenantContext.current();
    };
    const handler = handlerOf(async () => {
      await Promise.resolve();
      return service();
    });
    const result = await firstValueFrom(
      new TenantContextInterceptor().intercept(
        httpContext({ headers: {}, tenant }, () => {}),
        handler,
      ),
    );
    expect(result).toEqual({ tenantId: TENANT_ID, keyId: KEY_ID, scopes: ["chat"] });
    expect(() => TenantContext.current()).toThrow(UnauthenticatedError);
  });

  it("requisições concorrentes de tenants diferentes não se misturam", async () => {
    const other: AuthTenant = {
      ...tenant,
      tenantId: "11111111-2222-4333-8444-555555555555",
      keyId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    };
    const seen = (t: AuthTenant, delay: number) =>
      firstValueFrom(
        new TenantContextInterceptor().intercept(
          httpContext({ headers: {}, tenant: t }, () => {}),
          handlerOf(async () => {
            await new Promise((resolve) => setTimeout(resolve, delay));
            return TenantContext.current().tenantId;
          }),
        ),
      );
    const [a, b] = await Promise.all([seen(tenant, 20), seen(other, 1)]);
    expect(a).toBe(tenant.tenantId);
    expect(b).toBe(other.tenantId);
  });

  it("repassa todos os valores emitidos e os erros do handler", async () => {
    const interceptor = new TenantContextInterceptor();
    const ctx = httpContext({ headers: {}, tenant }, () => {});
    const many = await lastValueFrom(
      interceptor.intercept(ctx, { handle: () => from([1, 2, 3]) }).pipe(toArray()),
    );
    expect(many).toEqual([1, 2, 3]);

    const boom = new Error("boom");
    await expect(
      firstValueFrom(
        interceptor.intercept(
          ctx,
          handlerOf(() => Promise.reject(boom)),
        ),
      ),
    ).rejects.toBe(boom);
  });

  it("sem req.tenant (rota pública): passa adiante sem contexto", async () => {
    const result = await firstValueFrom(
      new TenantContextInterceptor().intercept(
        httpContext({ headers: {} }, () => {}),
        handlerOf(async () => {
          try {
            return TenantContext.current().tenantId;
          } catch {
            return "sem-contexto";
          }
        }),
      ),
    );
    expect(result).toBe("sem-contexto");
  });
});
