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
import {
  IS_PUBLIC_KEY,
  REQUIRED_SCOPES_KEY,
  SCOPES,
} from "../../src/modules/tenancy/scopes.decorator.js";
import { WatchtowerModule } from "../../src/modules/watchtower/watchtower.module.js";
import { createTestApp, type TestApp } from "../setup/app.js";

interface RouteInfo {
  route: string;
  isPublic: boolean;
  scopes: string[];
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
      imports: [BillingModule, WatchtowerModule, DataIngestionModule],
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
        "GET /clients/:clientId/positions",
        "GET /clients/:clientId/transactions",
        "GET /usage",
        "POST /clients/:clientId/positions",
        "POST /clients/:clientId/transactions",
      ].sort(),
    );
  });

  it("toda rota que não é @Public() declara ao menos um escopo válido", () => {
    const offenders = routes.filter(
      (r) =>
        !r.isPublic &&
        (r.scopes.length === 0 || r.scopes.some((s) => !(SCOPES as readonly string[]).includes(s))),
    );
    expect(offenders).toEqual([]);
  });

  it("POST exige data:write; GET exige chat", () => {
    for (const r of routes.filter((x) => !x.isPublic)) {
      expect(r.scopes, r.route).toEqual([r.route.startsWith("POST ") ? "data:write" : "chat"]);
    }
  });
});
