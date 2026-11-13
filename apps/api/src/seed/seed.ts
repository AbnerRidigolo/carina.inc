/**
 * Seed de DEMO (`pnpm --filter @carina/api seed`, depois do build; no docker compose, o serviço
 * `seed`). Idempotente: rodar de novo deixa o mesmo estado.
 *
 * 1. Com o papel carina_migrator (MIGRATION_DATABASE_URL; `tenant` e `api_key` não têm RLS e o
 *    carina_app nem enxerga `api_key`): tenant `demo` (rpm 120, cota 0 = ilimitada) e as duas
 *    chaves, gravadas só como sha256 (o mesmo `hashApiKey` do ApiKeyGuard):
 *    - DEMO_APP_KEY: `chat` + `data:write` (o app parceiro: conversa e envia dados);
 *    - DEMO_APPROVER_KEY: `chat` + `inbox:decide` (quem aprova ações irreversíveis).
 *    Uma chave antiga com o mesmo rótulo e outro valor (o env mudou) é revogada.
 * 2. Com o papel carina_app, sob o TenantContext do tenant demo: três clientes sintéticos
 *    (conservador, moderado e arrojado; seeds 1, 2 e 3; `asOf` = hoje em São Paulo) pela
 *    ingestão normal (`source: "synthetic"`) e então `SyncWorker.syncClient` direto, para os
 *    documentos de conhecimento já existirem quando a API subir. Cliente já semeado (posições e
 *    ≥ 2 documentos do Sync) é pulado: rodar de novo não cobra outra ingestão do tenant.
 *
 * As chaves padrão são FIXAS e públicas (estão no repositório): servem só para a demo local.
 * Com NODE_ENV=production o seed RECUSA qualquer uma delas, a menos que SEED_ALLOW_DEMO_KEYS=true
 * (o docker compose de demo liga isso de propósito). Nenhum valor de chave (nem prefixo nem hash)
 * vai para o log: só os ids.
 */
import { pathToFileURL } from "node:url";
import { type DynamicModule, type INestApplicationContext, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import pg from "pg";
import pino from "pino";
import { z } from "zod";
import { ConfigModule } from "../core/config/config.module.js";
import { type Env, loadEnv } from "../core/config/env.js";
import { TenantContext } from "../core/context/tenant-context.js";
import { TenantPrismaService } from "../core/database/tenant-prisma.service.js";
import { RedisModule } from "../core/redis/redis.module.js";
import { DataIngestionCoreModule } from "../modules/data-ingestion/data-ingestion-core.module.js";
import { IngestionService } from "../modules/data-ingestion/ingestion.service.js";
import { SYNC_SOURCE, SyncBusyError, SyncWorker } from "../modules/data-ingestion/sync.worker.js";
import { generatePortfolio, type Profile } from "../modules/data-ingestion/synthetic/generator.js";
import { hashApiKey } from "../modules/tenancy/api-key.js";
import { ClientsService } from "../modules/tenancy/clients.service.js";

/** Só para a demo local. Formato igual ao das chaves geradas: `sk-live-` + 32 base62. */
export const DEFAULT_DEMO_APP_KEY = "sk-live-demoapp0000000000000000000000000";
export const DEFAULT_DEMO_APPROVER_KEY = "sk-live-demoapprover00000000000000000000";

export const DEMO_TENANT = { name: "demo", plan: "demo", rpm: 120, monthlyQuota: 0 } as const;

export const DEMO_CLIENTS: readonly { externalId: string; profile: Profile; seed: number }[] = [
  { externalId: "cliente-conservador", profile: "conservador", seed: 1 },
  { externalId: "cliente-moderado", profile: "moderado", seed: 2 },
  { externalId: "cliente-arrojado", profile: "arrojado", seed: 3 },
];

const DEMO_KEYS = [
  { label: "demo-app", env: "DEMO_APP_KEY", scopes: ["chat", "data:write"] },
  { label: "demo-approver", env: "DEMO_APPROVER_KEY", scopes: ["chat", "inbox:decide"] },
] as const;

const KEY_FORMAT = /^sk-live-[0-9A-Za-z]{32}$/;
/** Lock consultivo do seed (dois seeds simultâneos não duplicam o tenant). */
const SEED_LOCK_ID = 0x5eed_0001;
const SYNC_BUSY_RETRIES = 10;
const SYNC_BUSY_DELAY_MS = 1000;

export class SeedRefusedError extends Error {
  override readonly name = "SeedRefusedError";
}

export interface SeedLogger {
  info(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
}

export interface SeedOptions {
  /** Ambiente (padrão: `process.env`). */
  env?: NodeJS.ProcessEnv;
  logger?: SeedLogger;
  /** Data das posições (`YYYY-MM-DD`); padrão: hoje em São Paulo. */
  asOf?: string;
}

export interface SeededClient {
  externalId: string;
  clientId: string;
  /** Já estava semeado: nada foi reingerido nem cobrado. */
  skipped: boolean;
  documents: number;
}

export interface SeedResult {
  tenantId: string;
  keyIds: { app: string; approver: string };
  clients: SeededClient[];
}

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

const SeedEnvSchema = z.object({
  DEMO_APP_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  DEMO_APPROVER_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  SEED_ALLOW_DEMO_KEYS: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).optional()),
});

interface DemoKeys {
  app: string;
  approver: string;
}

/** Valida as chaves e a regra de produção ANTES de qualquer conexão. */
export function resolveDemoKeys(raw: NodeJS.ProcessEnv, env: Pick<Env, "NODE_ENV">): DemoKeys {
  const parsed = SeedEnvSchema.parse(raw);
  const keys: DemoKeys = {
    app: parsed.DEMO_APP_KEY ?? DEFAULT_DEMO_APP_KEY,
    approver: parsed.DEMO_APPROVER_KEY ?? DEFAULT_DEMO_APPROVER_KEY,
  };
  for (const [name, value] of [
    ["DEMO_APP_KEY", keys.app],
    ["DEMO_APPROVER_KEY", keys.approver],
  ] as const) {
    // Sem o valor na mensagem: só o nome da variável.
    if (!KEY_FORMAT.test(value)) {
      throw new Error(`${name} precisa ter o formato sk-live- seguido de 32 caracteres base62`);
    }
  }
  if (keys.app === keys.approver) {
    throw new Error("DEMO_APP_KEY e DEMO_APPROVER_KEY precisam ser diferentes");
  }
  const usesFixed =
    keys.app === DEFAULT_DEMO_APP_KEY || keys.approver === DEFAULT_DEMO_APPROVER_KEY;
  if (env.NODE_ENV === "production" && usesFixed && parsed.SEED_ALLOW_DEMO_KEYS !== "true") {
    throw new SeedRefusedError(
      "Recusado: as chaves fixas de demo são públicas e não podem ir para produção. Defina " +
        "DEMO_APP_KEY/DEMO_APPROVER_KEY com chaves novas ou, só para a demo local, " +
        "SEED_ALLOW_DEMO_KEYS=true.",
    );
  }
  return keys;
}

/** Hoje (`YYYY-MM-DD`) no fuso de São Paulo, o mesmo dos meses de cobrança. */
export function todaySaoPaulo(now: Date = new Date()): string {
  // en-CA formata como YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Tenant e chaves como carina_migrator, numa transação com lock consultivo. */
async function upsertTenantAndKeys(
  migrationUrl: string,
  keys: DemoKeys,
): Promise<{ tenantId: string; keyIds: { app: string; approver: string } }> {
  const client = new pg.Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [SEED_LOCK_ID]);
    const found = await client.query<{ id: string }>(
      "SELECT id FROM tenant WHERE name = $1 ORDER BY created_at LIMIT 1",
      [DEMO_TENANT.name],
    );
    let tenantId = found.rows[0]?.id;
    if (tenantId === undefined) {
      const created = await client.query<{ id: string }>(
        "INSERT INTO tenant (name, plan, rpm, monthly_quota) VALUES ($1, $2, $3, $4) RETURNING id",
        [DEMO_TENANT.name, DEMO_TENANT.plan, DEMO_TENANT.rpm, DEMO_TENANT.monthlyQuota],
      );
      tenantId = created.rows[0]?.id;
      if (tenantId === undefined) throw new Error("INSERT INTO tenant não devolveu id");
    } else {
      await client.query(
        "UPDATE tenant SET plan = $2, rpm = $3, monthly_quota = $4, suspended_at = NULL WHERE id = $1",
        [tenantId, DEMO_TENANT.plan, DEMO_TENANT.rpm, DEMO_TENANT.monthlyQuota],
      );
    }

    const ids: Record<string, string> = {};
    for (const spec of DEMO_KEYS) {
      const key = spec.env === "DEMO_APP_KEY" ? keys.app : keys.approver;
      const hash = hashApiKey(key);
      // Reativa e reescopa a mesma chave; uma chave de OUTRO tenant com o mesmo hash não é tocada
      // (o WHERE do DO UPDATE falha e nada volta) e o seed para.
      const upserted = await client.query<{ id: string }>(
        `INSERT INTO api_key (tenant_id, hash, prefix, scopes, label)
         VALUES ($1, $2, $3, $4::text[], $5)
         ON CONFLICT (hash) DO UPDATE
           SET scopes = EXCLUDED.scopes, label = EXCLUDED.label, revoked_at = NULL
           WHERE api_key.tenant_id = EXCLUDED.tenant_id
         RETURNING id`,
        [tenantId, hash, key.slice(0, 12), spec.scopes, spec.label],
      );
      const id = upserted.rows[0]?.id;
      if (id === undefined) throw new Error(`${spec.env} já pertence a outro tenant`);
      ids[spec.label] = id;
      // A chave antiga deste rótulo (o env mudou de valor) deixa de valer.
      await client.query(
        `UPDATE api_key SET revoked_at = now()
         WHERE tenant_id = $1 AND label = $2 AND id <> $3 AND revoked_at IS NULL`,
        [tenantId, spec.label, id],
      );
    }
    await client.query("COMMIT");
    return {
      tenantId,
      keyIds: { app: ids["demo-app"] ?? "", approver: ids["demo-approver"] ?? "" },
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

/** Grafo mínimo do seed: ingestão + Sync (sem HTTP, sem workers ligados). */
@Module({ imports: [RedisModule, DataIngestionCoreModule] })
class SeedModule {}

function seedRoot(env: Env): DynamicModule {
  return { module: SeedModule, imports: [ConfigModule.forEnv(env)] };
}

/** Sync direto, com novas tentativas se o worker estiver sincronizando o mesmo cliente. */
async function syncWithRetry(
  sync: SyncWorker,
  tenantId: string,
  clientId: string,
  log: SeedLogger,
): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await sync.syncClient(tenantId, clientId)).documents;
    } catch (err) {
      if (!(err instanceof SyncBusyError) || attempt >= SYNC_BUSY_RETRIES) throw err;
      log.warn({ msg: "Sync do cliente ocupado; nova tentativa", tenantId, clientId, attempt });
      await new Promise((r) => setTimeout(r, SYNC_BUSY_DELAY_MS));
    }
  }
}

async function seedClients(
  ctx: INestApplicationContext,
  tenantId: string,
  asOf: string,
  log: SeedLogger,
): Promise<SeededClient[]> {
  const ingestion = ctx.get(IngestionService);
  const clients = ctx.get(ClientsService);
  const sync = ctx.get(SyncWorker);
  const db = ctx.get(TenantPrismaService);
  const out: SeededClient[] = [];

  for (const spec of DEMO_CLIENTS) {
    const seeded = await TenantContext.run({ tenantId }, async () => {
      const existing = await clients.resolve(spec.externalId, { create: true });
      const counts = await TenantContext.withClient(existing.id, async () => ({
        positions: await db.client.position.count({ where: { clientId: existing.id } }),
        documents: await db.client.kgDocument.count({
          where: { clientId: existing.id, source: SYNC_SOURCE },
        }),
      }));
      if (counts.positions > 0 && counts.documents >= 2) {
        return { clientId: existing.id, skipped: true, documents: counts.documents };
      }
      const portfolio = generatePortfolio(spec.profile, spec.seed, asOf);
      await ingestion.upsertPositions(spec.externalId, "synthetic", portfolio.positions);
      await ingestion.upsertTransactions(spec.externalId, "synthetic", portfolio.transactions);
      return { clientId: existing.id, skipped: false, documents: 0 };
    });
    const documents = seeded.skipped
      ? seeded.documents
      : await syncWithRetry(sync, tenantId, seeded.clientId, log);
    log.info({
      msg: seeded.skipped ? "Cliente já semeado" : "Cliente semeado",
      tenantId,
      clientId: seeded.clientId,
      externalId: spec.externalId,
      documents,
    });
    out.push({ externalId: spec.externalId, ...seeded, documents });
  }
  return out;
}

export async function seed(opts: SeedOptions = {}): Promise<SeedResult> {
  const raw = opts.env ?? process.env;
  // Os workers nunca ligam no seed: o Sync roda direto, aqui.
  const env = loadEnv({ ...raw, WORKERS_ENABLED: "false" });
  const log: SeedLogger = opts.logger ?? defaultLogger(env);
  const keys = resolveDemoKeys(raw, env);
  const asOf = opts.asOf ?? todaySaoPaulo();

  if (env.MIGRATION_DATABASE_URL === undefined) {
    throw new Error("MIGRATION_DATABASE_URL é obrigatória no seed (papel carina_migrator)");
  }
  const { tenantId, keyIds } = await upsertTenantAndKeys(env.MIGRATION_DATABASE_URL, keys);
  log.info({ msg: "Tenant e chaves de demo prontos", tenantId, keyIds });

  const ctx = await NestFactory.createApplicationContext(seedRoot(env), {
    logger: env.LOG_LEVEL === "silent" ? false : ["error", "warn"],
    abortOnError: false,
  });
  try {
    const clients = await seedClients(ctx, tenantId, asOf, log);
    log.info({ msg: "Seed de demo concluído", tenantId, clients: clients.length, asOf });
    return { tenantId, keyIds, clients };
  } finally {
    await ctx.close();
  }
}

function defaultLogger(env: Pick<Env, "LOG_LEVEL">): SeedLogger {
  const logger = pino({ name: "seed", level: env.LOG_LEVEL });
  return { info: (f) => logger.info(f), warn: (f) => logger.warn(f) };
}

// Execução direta (`node dist/seed/seed.js`); importar o módulo (testes) não roda o seed.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    await seed();
  } catch (err) {
    console.error("Seed falhou:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
