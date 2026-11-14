/**
 * Grafo de módulos de PRODUÇÃO: o AppModule (processo HTTP, main.ts) e o WorkerModule (processo
 * sem HTTP, main.worker.ts) instanciam de fato cada worker de fundo, e os workers só ligam com
 * WORKERS_ENABLED !== "false". O WorkerModule não carrega controllers, gateway nem broadcast.
 *
 * O `consume` do StreamsService é trocado por um no-op que espera o abort: o teste prova que cada
 * worker pediu o seu grupo de consumo sem roubar eventos do stream `jobs` de outros testes.
 * Redis: DB lógico próprio (test/setup/redis-dbs.ts), sem depender do conteúdo (nada é lido nem esvaziado aqui).
 */
import { ModulesContainer } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { ENV } from "../../src/core/config/config.module.js";
import { loadEnv } from "../../src/core/config/env.js";
import { StreamsService, type ConsumeOptions } from "../../src/core/redis/streams.service.js";
import { ChatGateway } from "../../src/modules/chat/chat.gateway.js";
import { InboxBroadcast } from "../../src/modules/chat/inbox-broadcast.js";
import { SyncWorker } from "../../src/modules/data-ingestion/sync.worker.js";
import { MarketService } from "../../src/modules/market/market.service.js";
import { MarketController } from "../../src/modules/market/market.controller.js";
import { HealthController } from "../../src/modules/health/health.controller.js";
import { ReconciliationJob } from "../../src/modules/inbox/reconciliation.job.js";
import { ResumeWorker } from "../../src/modules/orchestrator/resume.worker.js";
import { WorkerModule } from "../../src/worker.module.js";
import { appUrl, migratorUrl, redisDbUrl } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

const REDIS_DB = redisDbOf("app/app-graph.int.spec.ts");

function env(workers: "true" | "false") {
  return loadEnv({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: appUrl(),
    MIGRATION_DATABASE_URL: migratorUrl(),
    REDIS_URL: redisDbUrl(REDIS_DB),
    LLM_MODE: "mock",
    LOG_LEVEL: "silent",
    WORKERS_ENABLED: workers,
  });
}

/** Grupos pedidos ao `consume` (o no-op só resolve no abort, no shutdown). */
function stubConsume(): string[] {
  const groups: string[] = [];
  vi.spyOn(StreamsService.prototype, "consume").mockImplementation((opts: ConsumeOptions) => {
    groups.push(`${opts.stream}:${opts.group}`);
    return new Promise<void>((resolve) => {
      if (opts.signal.aborted) resolve();
      else opts.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  return groups;
}

function controllersOf(ref: TestingModule): string[] {
  const names: string[] = [];
  for (const m of ref.get(ModulesContainer).values()) {
    for (const c of m.controllers.values()) names.push(c.name);
  }
  return names.sort();
}

async function boot(root: unknown, workers: "true" | "false"): Promise<TestingModule> {
  const ref = await Test.createTestingModule({ imports: [root as never] })
    .overrideProvider(ENV)
    .useValue(env(workers))
    .compile();
  await ref.init();
  return ref;
}

describe("grafo de módulos de produção", () => {
  let ref: TestingModule | undefined;

  afterEach(async () => {
    await ref?.close();
    ref = undefined;
    vi.restoreAllMocks();
  });

  it("AppModule com WORKERS_ENABLED=true: os três workers ligam, mais o broadcast e o gateway", async () => {
    const groups = stubConsume();
    ref = await boot(AppModule.register(), "true");

    expect(ref.get(SyncWorker).running).toBe(true);
    expect(ref.get(ResumeWorker).running).toBe(true);
    expect(ref.get(ReconciliationJob).running).toBe(true);
    expect(ref.get(InboxBroadcast)).toBeInstanceOf(InboxBroadcast);
    expect(ref.get(ChatGateway)).toBeInstanceOf(ChatGateway);
    expect(ref.get(HealthController)).toBeInstanceOf(HealthController);
    expect(groups.sort()).toEqual(["jobs:resumers", "jobs:sync"]);
  });

  it("AppModule com WORKERS_ENABLED=false: providers existem, mas nenhum worker liga", async () => {
    const groups = stubConsume();
    ref = await boot(AppModule.register(), "false");

    expect(ref.get(SyncWorker).running).toBe(false);
    expect(ref.get(ResumeWorker).running).toBe(false);
    expect(ref.get(ReconciliationJob).running).toBe(false);
    // O broadcast da inbox é por processo HTTP (repassa aos sockets dele), não é worker.
    expect(ref.get(InboxBroadcast)).toBeInstanceOf(InboxBroadcast);
    expect(groups).toEqual([]);
    expect(controllersOf(ref)).toEqual(
      [
        "BillingController",
        "ChatController",
        "ClientsController",
        "HealthController",
        "InboxController",
        "IngestionController",
        "MarketController",
        "WatchtowerController",
      ].sort(),
    );
  });

  it("WorkerModule: os três workers ligam; nenhum controller, gateway ou broadcast", async () => {
    const groups = stubConsume();
    ref = await boot(WorkerModule, "true");

    expect(ref.get(SyncWorker).running).toBe(true);
    expect(ref.get(ResumeWorker).running).toBe(true);
    expect(ref.get(ReconciliationJob).running).toBe(true);
    expect(groups.sort()).toEqual(["jobs:resumers", "jobs:sync"]);
    expect(controllersOf(ref)).toEqual([]);
    expect(ref.get(MarketService)).toBeInstanceOf(MarketService);
    expect(() => ref?.get(MarketController, { strict: false })).toThrow();
    expect(() => ref?.get(InboxBroadcast)).toThrow();
    expect(() => ref?.get(ChatGateway)).toThrow();
  });
});
