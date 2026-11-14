/**
 * Trava de segurança: toda rota HTTP registrada que não é @Public() declara ao menos um escopo
 * (`@RequireScopes`). Sem isso, uma rota nova esquecida ficaria acessível a qualquer chave válida.
 * Enumera, por reflexão (ModulesContainer), os controllers do AppModule REAL de produção (o mesmo do
 * main.ts), inclusive handlers herdados de classes-base. Rotas @Public() (health/ready) também
 * entram na lista, para que uma rota pública nova precise ser declarada aqui de propósito.
 */
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { RequestMethod } from "@nestjs/common";
import { ModulesContainer, Reflector } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../../src/app.module.js";
import {
  IS_PUBLIC_KEY,
  REQUIRED_ANY_SCOPES_KEY,
  REQUIRED_SCOPES_KEY,
  SCOPES,
} from "../../src/modules/tenancy/scopes.decorator.js";
import { createTestApp, type TestApp } from "../setup/app.js";
import { redisDbOf } from "../setup/redis-dbs.js";

interface RouteInfo {
  route: string;
  isPublic: boolean;
  scopes: string[];
  anyScopes: string[];
}

/** Nomes de métodos do protótipo e das classes-base (até Object.prototype), sem repetir. */
function handlerNames(controller: new (...args: never[]) => object): string[] {
  const names = new Set<string>();
  for (
    let proto: object | null = controller.prototype as object;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const name of Object.getOwnPropertyNames(proto))
      if (name !== "constructor") names.add(name);
  }
  return [...names];
}

function enumerateRoutes(app: TestApp["app"]): RouteInfo[] {
  const reflector = app.get(Reflector);
  const routes: RouteInfo[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (!controller) continue;
      const basePath = String(Reflect.getMetadata(PATH_METADATA, controller) ?? "");
      for (const name of handlerNames(controller)) {
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== "function") continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const path = String(Reflect.getMetadata(PATH_METADATA, handler) ?? "");
        const targets = [handler, controller];
        routes.push({
          route: `${RequestMethod[method]} /${[basePath, path]
            .map((p) => p.replace(/^\/+|\/+$/g, ""))
            .filter(Boolean)
            .join("/")}`,
          isPublic:
            reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets) === true,
          scopes:
            reflector.getAllAndOverride<string[] | undefined>(REQUIRED_SCOPES_KEY, targets) ?? [],
          anyScopes:
            reflector.getAllAndOverride<string[] | undefined>(REQUIRED_ANY_SCOPES_KEY, targets) ??
            [],
        });
      }
    }
  }
  return routes;
}

describe("Escopos das rotas registradas", () => {
  let t: TestApp;
  let routes: RouteInfo[];

  beforeAll(async () => {
    t = await createTestApp({
      imports: [AppModule.register()],
      redisDb: redisDbOf("routes/route-scopes.e2e.spec.ts"),
    });
    routes = enumerateRoutes(t.app);
  });

  afterAll(async () => {
    await t?.close();
  });

  it("enumera as rotas conhecidas (a reflexão não passa vazia)", () => {
    expect(routes.map((r) => r.route).sort()).toEqual(
      [
        "GET /audit",
        "GET /clients",
        "GET /clients/:clientId/inbox",
        "GET /clients/:clientId/positions",
        "GET /clients/:clientId/transactions",
        "GET /health",
        "GET /market/history/:symbol",
        "GET /market/macro",
        "GET /market/quotes",
        "GET /ready",
        "GET /usage",
        "POST /chat",
        "POST /clients/:clientId/positions",
        "POST /inbox/:id/decision",
        "POST /clients/:clientId/transactions",
        "POST /ws/ticket",
      ].sort(),
    );
  });

  const scopeCount = (r: RouteInfo) => r.scopes.length + r.anyScopes.length;
  const isValid = (s: string) => (SCOPES as readonly string[]).includes(s);

  it("só health e ready são @Public()", () => {
    expect(
      routes
        .filter((r) => r.isPublic)
        .map((r) => r.route)
        .sort(),
    ).toEqual(["GET /health", "GET /ready"]);
  });

  it("toda rota que não é @Public() declara ao menos um escopo válido (E ou OU)", () => {
    const offenders = routes.filter(
      (r) =>
        !r.isPublic &&
        (scopeCount(r) === 0 || [...r.scopes, ...r.anyScopes].some((s) => !isValid(s))),
    );
    expect(offenders).toEqual([]);
  });

  it("escopo exigido de cada rota (inbox: listagem chat OU inbox:decide, decisão inbox:decide; chat e ticket: chat)", () => {
    const expected = (r: RouteInfo): { all: string[]; any: string[] } => {
      if (r.route === "GET /clients/:clientId/inbox")
        return { all: [], any: ["chat", "inbox:decide"] };
      if (r.route === "POST /inbox/:id/decision") return { all: ["inbox:decide"], any: [] };
      if (r.route === "POST /chat" || r.route === "POST /ws/ticket")
        return { all: ["chat"], any: [] };
      if (r.route.startsWith("GET /market/")) return { all: ["market:read"], any: [] };
      return { all: [r.route.startsWith("POST ") ? "data:write" : "chat"], any: [] };
    };
    for (const r of routes.filter((x) => !x.isPublic)) {
      expect({ all: r.scopes, any: r.anyScopes }, r.route).toEqual(expected(r));
    }
  });
});
