/**
 * Trava de segurança: toda rota HTTP registrada que não é @Public() declara ao menos um escopo
 * (`@RequireScopes`). Sem isso, uma rota nova esquecida ficaria acessível a qualquer chave válida.
 * Enumera os controllers de todos os módulos com rotas por reflexão (ModulesContainer).
 */
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { RequestMethod } from "@nestjs/common";
import { ModulesContainer, Reflector } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BillingModule } from "../../src/modules/billing/billing.module.js";
import { DataIngestionModule } from "../../src/modules/data-ingestion/data-ingestion.module.js";
import { InboxModule } from "../../src/modules/inbox/inbox.module.js";
import {
  IS_PUBLIC_KEY,
  REQUIRED_ANY_SCOPES_KEY,
  REQUIRED_SCOPES_KEY,
  SCOPES,
} from "../../src/modules/tenancy/scopes.decorator.js";
import { WatchtowerModule } from "../../src/modules/watchtower/watchtower.module.js";
import { createTestApp, type TestApp } from "../setup/app.js";

interface RouteInfo {
  route: string;
  isPublic: boolean;
  scopes: string[];
  anyScopes: string[];
}

function enumerateRoutes(app: TestApp["app"]): RouteInfo[] {
  const reflector = app.get(Reflector);
  const routes: RouteInfo[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (!controller) continue;
      const basePath = String(Reflect.getMetadata(PATH_METADATA, controller) ?? "");
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
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
      imports: [BillingModule, WatchtowerModule, DataIngestionModule, InboxModule],
      redisDb: 10,
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
        "GET /usage",
        "POST /clients/:clientId/positions",
        "POST /inbox/:id/decision",
        "POST /clients/:clientId/transactions",
      ].sort(),
    );
  });

  const scopeCount = (r: RouteInfo) => r.scopes.length + r.anyScopes.length;
  const isValid = (s: string) => (SCOPES as readonly string[]).includes(s);

  it("toda rota que não é @Public() declara ao menos um escopo válido (E ou OU)", () => {
    const offenders = routes.filter(
      (r) =>
        !r.isPublic &&
        (scopeCount(r) === 0 || [...r.scopes, ...r.anyScopes].some((s) => !isValid(s))),
    );
    expect(offenders).toEqual([]);
  });

  it("escopo exigido de cada rota (inbox: listagem chat OU inbox:decide, decisão inbox:decide)", () => {
    const expected = (r: RouteInfo): { all: string[]; any: string[] } => {
      if (r.route === "GET /clients/:clientId/inbox")
        return { all: [], any: ["chat", "inbox:decide"] };
      if (r.route === "POST /inbox/:id/decision") return { all: ["inbox:decide"], any: [] };
      return { all: [r.route.startsWith("POST ") ? "data:write" : "chat"], any: [] };
    };
    for (const r of routes.filter((x) => !x.isPublic)) {
      expect({ all: r.scopes, any: r.anyScopes }, r.route).toEqual(expected(r));
    }
  });
});
