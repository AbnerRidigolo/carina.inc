/**
 * App Nest para testes E2E, conectado ao banco de teste do global-setup como carina_app.
 *
 * Monta o mesmo pipeline HTTP do main.ts (prefixo `/api` e ProblemDetailsFilter) sobre o
 * TenancyModule (ApiKeyGuard + TenantContextInterceptor globais) e os módulos extras que cada
 * teste passar. Tenants e chaves são criados como carina_migrator (`tenant` e `api_key` não têm
 * RLS; o carina_app nem enxerga `api_key`).
 */
import type { DynamicModule, INestApplication, Type } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigModule, ENV } from "../../src/core/config/config.module.js";
import { loadEnv } from "../../src/core/config/env.js";
import { ProblemDetailsFilter } from "../../src/core/errors/problem-details.filter.js";
import { generateApiKey, hashApiKey } from "../../src/modules/tenancy/api-key.js";
import { TenancyModule } from "../../src/modules/tenancy/tenancy.module.js";
import { appUrl, migratorSql, migratorUrl, redisDbUrl, redisUrl } from "./db.js";

export type SeedKeyName = "chat" | "approver" | "ingest";

/** Escopos de cada chave criada por `seedTenant`. */
export const SEED_KEY_SCOPES: Record<SeedKeyName, string[]> = {
  chat: ["chat"],
  approver: ["chat", "inbox:decide"],
  ingest: ["data:write"],
};

export interface SeedTenantOptions {
  name?: string;
  plan?: string;
  rpm?: number;
  monthlyQuota?: number;
}

export interface SeededTenant {
  tenantId: string;
  keys: Record<SeedKeyName, string>;
}

export interface CreateKeyOptions {
  /** `null` grava a coluna como NULL (a coluna é anulável). */
  scopes: string[] | null;
  revoked?: boolean;
  label?: string;
}

export interface TestApp {
  app: INestApplication;
  seedTenant(opts?: SeedTenantOptions): Promise<SeededTenant>;
  /** Cria uma chave avulsa para o tenant; devolve a chave em texto. */
  createKey(tenantId: string, opts: CreateKeyOptions): Promise<string>;
  /** Revoga uma chave pelo texto. */
  revokeKey(key: string): Promise<void>;
  close(): Promise<void>;
}

type ModuleImport = Type | DynamicModule;

export interface CreateTestAppOptions {
  imports?: ModuleImport[];
  /** Substitui providers (ex.: o relógio CLOCK dos limites). */
  overrides?: { token: unknown; useValue: unknown }[];
  /** DB lógico do Redis do app; cada arquivo de teste usa o seu para não colidir com os demais. */
  redisDb?: number;
}

export async function createTestApp(opts: CreateTestAppOptions = {}): Promise<TestApp> {
  const env = loadEnv({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: appUrl(),
    MIGRATION_DATABASE_URL: migratorUrl(),
    REDIS_URL: opts.redisDb === undefined ? redisUrl() : redisDbUrl(opts.redisDb),
    LLM_MODE: "mock",
  });

  let builder = Test.createTestingModule({
    imports: [ConfigModule, TenancyModule, ...(opts.imports ?? [])],
  })
    .overrideProvider(ENV)
    .useValue(env);
  for (const o of opts.overrides ?? [])
    builder = builder.overrideProvider(o.token).useValue(o.useValue);
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix("api");
  app.useGlobalFilters(new ProblemDetailsFilter());
  // Escuta numa porta efêmera: o supertest usa o endereço em vez de abrir um listen por request.
  await app.listen(0, "127.0.0.1");

  const createKey = async (tenantId: string, k: CreateKeyOptions): Promise<string> => {
    const { key, hash, prefix } = generateApiKey();
    await migratorSql(
      `INSERT INTO api_key (tenant_id, hash, prefix, scopes, label, revoked_at)
       VALUES ($1, $2, $3, $4::text[], $5, CASE WHEN $6::boolean THEN now() END)`,
      [tenantId, hash, prefix, k.scopes, k.label ?? null, k.revoked ?? false],
    );
    return key;
  };

  const seedTenant = async (s: SeedTenantOptions = {}): Promise<SeededTenant> => {
    const [tenant] = await migratorSql<{ id: string }>(
      `INSERT INTO tenant (name, plan, rpm, monthly_quota) VALUES ($1, $2, $3, $4) RETURNING id`,
      [s.name ?? "Tenant de teste", s.plan ?? "pro", s.rpm ?? 1000, s.monthlyQuota ?? 0],
    );
    if (!tenant) throw new Error("INSERT INTO tenant não devolveu id");
    const keys = {} as Record<SeedKeyName, string>;
    for (const name of Object.keys(SEED_KEY_SCOPES) as SeedKeyName[]) {
      keys[name] = await createKey(tenant.id, { scopes: SEED_KEY_SCOPES[name], label: name });
    }
    return { tenantId: tenant.id, keys };
  };

  const revokeKey = async (key: string): Promise<void> => {
    await migratorSql(`UPDATE api_key SET revoked_at = now() WHERE hash = $1`, [hashApiKey(key)]);
  };

  return { app, seedTenant, createKey, revokeKey, close: () => app.close() };
}
