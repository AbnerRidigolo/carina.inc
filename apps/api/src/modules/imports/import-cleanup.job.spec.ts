import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantContext } from "../../core/context/tenant-context.js";
import {
  IMPORT_CLEANUP_INTERVAL_MS,
  IMPORT_CLEANUP_LOCK_KEY,
  ImportCleanupJob,
} from "./import-cleanup.job.js";
import type { ImportLogger } from "./import.worker.js";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const C1 = "33333333-3333-4333-8333-333333333333";
const J1 = "44444444-4444-4444-8444-444444444444";
const J2 = "55555555-5555-4555-8555-555555555555";

function setup(opts: { lock?: boolean; workers?: "true" | "false" } = {}) {
  const lock = { assertHeld: vi.fn(), release: vi.fn().mockResolvedValue(true) };
  const locks = { acquire: vi.fn().mockResolvedValue(opts.lock === false ? null : lock) };
  const db = { importCleanupTenantIds: vi.fn().mockResolvedValue([T1, T2]) };
  const repo = {
    expireFiles: vi.fn().mockResolvedValue([]),
    failStuck: vi.fn().mockResolvedValue([]),
  };
  const publish = vi.fn().mockResolvedValue("1-0");
  const logger: ImportLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const job = new ImportCleanupJob(
    { WORKERS_ENABLED: opts.workers ?? "false" },
    db as never,
    repo as never,
    { publish } as never,
    locks as never,
    () => NOW,
    logger,
  );
  return { job, lock, locks, db, repo, publish, logger };
}

describe("ImportCleanupJob.run", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lock ocupado → pula o tick", async () => {
    const s = setup({ lock: false });
    expect(await s.job.run()).toEqual({ skipped: true, tenants: 0, expired: 0, stuck: 0 });
    expect(s.locks.acquire).toHaveBeenCalledWith(IMPORT_CLEANUP_LOCK_KEY, expect.any(Number));
    expect(s.db.importCleanupTenantIds).not.toHaveBeenCalled();
  });

  it("corta em now − 1 h (arquivos) e now − 15 min (parsing parado), por tenant, e publica o término", async () => {
    const s = setup();
    const filesBefore = new Date(NOW - 60 * 60_000);
    const stuckBefore = new Date(NOW - 15 * 60_000);
    s.repo.expireFiles.mockImplementation(() => {
      expect(TenantContext.current().clientId).toBeUndefined();
      return Promise.resolve(
        TenantContext.current().tenantId === T1 ? [{ id: J1, clientId: C1 }] : [],
      );
    });
    s.repo.failStuck.mockImplementation(() =>
      Promise.resolve(TenantContext.current().tenantId === T2 ? [{ id: J2, clientId: C1 }] : []),
    );
    expect(await s.job.run()).toEqual({ skipped: false, tenants: 2, expired: 1, stuck: 1 });
    expect(s.db.importCleanupTenantIds).toHaveBeenCalledWith(filesBefore, stuckBefore);
    expect(s.repo.expireFiles).toHaveBeenCalledWith(filesBefore);
    expect(s.repo.failStuck).toHaveBeenCalledWith(stuckBefore);
    expect(s.lock.assertHeld).toHaveBeenCalledTimes(2);
    expect(s.lock.release).toHaveBeenCalled();
    expect(s.publish.mock.calls.map(([stream, e]) => [stream, e])).toEqual([
      [
        "inbox.events",
        expect.objectContaining({
          type: "import.finished",
          tenantId: T1,
          clientId: C1,
          importJobId: J1,
          status: "failed",
        }),
      ],
      [
        "inbox.events",
        expect.objectContaining({ type: "import.finished", tenantId: T2, importJobId: J2 }),
      ],
    ]);
  });

  it("onlyTenants restringe o tick; um tenant que falha não impede os demais", async () => {
    const s = setup();
    s.repo.expireFiles.mockRejectedValueOnce(new Error("x"));
    expect(await s.job.run({ onlyTenants: [T1.toUpperCase(), T2] })).toMatchObject({
      tenants: 2,
    });
    expect(s.repo.failStuck).toHaveBeenCalledTimes(1);
    expect(s.logger.error).toHaveBeenCalledWith(expect.objectContaining({ tenantId: T1 }));
    const only = setup();
    expect(await only.job.run({ onlyTenants: [T2] })).toMatchObject({ tenants: 1 });
  });

  it("falha ao publicar o término só é registrada", async () => {
    const s = setup();
    s.repo.failStuck.mockResolvedValue([{ id: J1, clientId: C1 }]);
    s.publish.mockRejectedValue(new Error("redis fora"));
    expect(await s.job.run({ onlyTenants: [T1] })).toMatchObject({ stuck: 1 });
    expect(s.logger.error).toHaveBeenCalled();
  });
});

describe("ImportCleanupJob: ciclo de vida", () => {
  it("WORKERS_ENABLED=false não liga o timer", () => {
    const s = setup();
    s.job.onApplicationBootstrap();
    expect(s.job.running).toBe(false);
  });

  it("timer de 5 min unref; um tick por vez; stop espera o tick", async () => {
    vi.useFakeTimers();
    const s = setup({ workers: "true" });
    let release!: () => void;
    s.db.importCleanupTenantIds.mockImplementation(
      () => new Promise<string[]>((r) => (release = () => r([]))),
    );
    s.job.onApplicationBootstrap();
    s.job.start();
    expect(s.job.running).toBe(true);
    expect(IMPORT_CLEANUP_INTERVAL_MS).toBe(5 * 60_000);
    await vi.advanceTimersByTimeAsync(IMPORT_CLEANUP_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(IMPORT_CLEANUP_INTERVAL_MS);
    expect(s.locks.acquire).toHaveBeenCalledTimes(1);
    const stopped = s.job.onModuleDestroy();
    release();
    await stopped;
    await s.job.beforeApplicationShutdown();
    expect(s.job.running).toBe(false);
  });

  it("tick que falha é registrado", async () => {
    vi.useFakeTimers();
    const s = setup({ workers: "true" });
    s.locks.acquire.mockRejectedValue(new Error("redis"));
    s.job.start();
    await vi.advanceTimersByTimeAsync(IMPORT_CLEANUP_INTERVAL_MS);
    expect(s.logger.error).toHaveBeenCalled();
    await s.job.stop();
  });
});
