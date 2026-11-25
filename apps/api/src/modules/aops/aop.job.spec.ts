import type { Aop, StreamEvent } from "@carina/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantContext } from "../../core/context/tenant-context.js";
import { LockLostError } from "../../core/redis/lock.service.js";
import type { AopLogger, AopRunOptions, AopRunSummary } from "./aop-runner.js";
import { AOP_GROUP, AOP_LOCK_KEY, AOP_STREAM, AopJob, aopManualLockKey } from "./aop.job.js";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const A1 = "33333333-3333-4333-8333-333333333333";
const A2 = "44444444-4444-4444-8444-444444444444";
const A3 = "55555555-5555-4555-8555-555555555555";
const TICK = 300_000;

// 2026-11-27 é sexta; 12:05Z = 9h05 em São Paulo. O disparo semanal de sexta 9h é 12:00Z.
const FRIDAY_0905 = Date.parse("2026-11-27T12:05:00.000Z");
const FIRE_0900 = new Date("2026-11-27T12:00:00.000Z");
const MANUAL_0901 = "2026-11-27T12:01:00.000Z";

const aopOf = (id: string, over: Partial<Aop> = {}): Aop => ({
  id,
  name: "Carteira premium",
  description: "Toda sexta às 9h, analise a carteira",
  agents: ["insight"],
  schedule: { frequency: "weekly", weekday: 4, day: 1, hour: 9 },
  clientIds: ["c1"],
  enabled: true,
  createdAt: "2026-11-01T12:00:00.000Z",
  lastFireAt: null,
  ...over,
});

const SUMMARY: AopRunSummary = {
  ok: 1,
  failed: 0,
  skipped: 0,
  alreadyRan: 0,
  errors: 0,
  clients: [],
};

/** Banco falso compartilhado entre réplicas: `claimFire` com a semântica do UPDATE condicional. */
function fakeStore(aops: Record<string, Aop[]>) {
  const fakeTx = { fake: true };
  const db = { tx: vi.fn(<T>(fn: (tx: unknown) => Promise<T>) => fn(fakeTx)) };
  const find = (id: string) =>
    Object.values(aops)
      .flat()
      .find((a) => a.id === id);
  const repo = {
    tenantIds: vi.fn(() => Promise.resolve(Object.keys(aops))),
    dueAops: vi.fn((tx: unknown) => {
      expect(tx).toBe(fakeTx);
      expect(TenantContext.current().clientId).toBeUndefined();
      return Promise.resolve(
        (aops[TenantContext.current().tenantId] ?? [])
          .filter((a) => a.enabled)
          .map((a) => ({ ...a })),
      );
    }),
    claimFire: vi.fn((tx: unknown, id: string, fireAt: Date) => {
      expect(tx).toBe(fakeTx);
      const aop = find(id);
      if (!aop?.enabled) return Promise.resolve(false);
      if (aop.lastFireAt !== null && Date.parse(aop.lastFireAt) >= fireAt.getTime()) {
        return Promise.resolve(false);
      }
      aop.lastFireAt = fireAt.toISOString();
      return Promise.resolve(true);
    }),
    get: vi.fn((tx: unknown, id: string) => {
      expect(tx).toBe(fakeTx);
      const aop = (aops[TenantContext.current().tenantId] ?? []).find((a) => a.id === id);
      return Promise.resolve(aop ? { ...aop } : null);
    }),
  };
  return { db, repo };
}

interface SetupOpts {
  now?: number;
  lock?: boolean;
  workers?: "true" | "false";
  aops?: Record<string, Aop[]>;
  store?: ReturnType<typeof fakeStore>;
}

function setup(opts: SetupOpts = {}) {
  const store = opts.store ?? fakeStore(opts.aops ?? { [T1]: [aopOf(A1)] });
  const lock = {
    assertHeld: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(true),
  };
  const held = new Set<string>();
  const locks = {
    acquire: vi.fn((key: string) => {
      if (key === AOP_LOCK_KEY) return Promise.resolve(opts.lock === false ? null : lock);
      // lock do disparo manual: um dono por vez
      if (held.has(key)) return Promise.resolve(null);
      held.add(key);
      return Promise.resolve({
        assertHeld: vi.fn().mockResolvedValue(undefined),
        release: vi.fn(() => {
          held.delete(key);
          return Promise.resolve(true);
        }),
      });
    }),
  };
  const fired: { tenantId: string; aopId: string; opts: AopRunOptions }[] = [];
  const runner = {
    run: vi.fn((aop: Aop, o: AopRunOptions) => {
      fired.push({ tenantId: TenantContext.current().tenantId, aopId: aop.id, opts: o });
      return Promise.resolve(SUMMARY);
    }),
  };
  const streams = {
    consume: vi.fn(
      (o: { signal: AbortSignal }) =>
        new Promise<void>((resolve) => {
          o.signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    ),
  };
  const logger: AopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const job = new AopJob(
    { WORKERS_ENABLED: opts.workers ?? "false", AOP_TICK_MS: TICK },
    store.db as never,
    store.repo as never,
    runner as never,
    streams as never,
    locks as never,
    () => opts.now ?? FRIDAY_0905,
    logger,
  );
  return { job, store, lock, locks, runner, fired, streams, logger };
}

const manualEvent = (over: Partial<Record<string, unknown>> = {}): StreamEvent =>
  ({
    type: "aop.run_requested",
    eventId: "66666666-6666-4666-8666-666666666666",
    tenantId: T1,
    clientId: "",
    aopId: A1,
    fireAt: MANUAL_0901,
    ...over,
  }) as StreamEvent;

describe("AopJob.runOnce (agenda)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("AOP vencido: disparo idempotente no horário agendado e execução sob o tenant", async () => {
    const s = setup();
    expect(await s.job.runOnce()).toEqual({ skipped: false, tenants: 1, fired: 1, failed: 0 });
    expect(s.store.repo.claimFire).toHaveBeenCalledWith(expect.anything(), A1, FIRE_0900);
    expect(s.fired).toEqual([
      { tenantId: T1, aopId: A1, opts: { fireAt: FIRE_0900, trigger: "schedule" } },
    ]);
    expect(s.locks.acquire).toHaveBeenCalledWith(AOP_LOCK_KEY, expect.any(Number));
    expect(s.lock.release).toHaveBeenCalled();
  });

  it("fora do horário não roda (o disparo de agora já foi feito)", async () => {
    const s = setup({ aops: { [T1]: [aopOf(A1, { lastFireAt: FIRE_0900.toISOString() })] } });
    expect(await s.job.runOnce()).toMatchObject({ fired: 0 });
    expect(s.store.repo.claimFire).not.toHaveBeenCalled();
    expect(s.runner.run).not.toHaveBeenCalled();
  });

  it("lock tomado por outra réplica → pula sem ler tenants", async () => {
    const s = setup({ lock: false });
    expect(await s.job.runOnce()).toEqual({ skipped: true, tenants: 0, fired: 0, failed: 0 });
    expect(s.store.repo.tenantIds).not.toHaveBeenCalled();
    expect(s.runner.run).not.toHaveBeenCalled();
  });

  it("duas réplicas no mesmo fire (lock expirado entre elas) → roda uma vez (RF 1)", async () => {
    const store = fakeStore({ [T1]: [aopOf(A1)] });
    const a = setup({ store });
    const b = setup({ store });
    const [ra, rb] = await Promise.all([a.job.runOnce(), b.job.runOnce()]);
    expect(ra.fired + rb.fired).toBe(1);
    expect(a.runner.run.mock.calls.length + b.runner.run.mock.calls.length).toBe(1);
    // e o tick seguinte não dispara de novo
    expect((await a.job.runOnce()).fired).toBe(0);
    expect(a.runner.run.mock.calls.length + b.runner.run.mock.calls.length).toBe(1);
  });

  it("falha de um AOP não derruba os outros (nem a de um tenant)", async () => {
    const s = setup({
      aops: { [T1]: [aopOf(A1), aopOf(A2)], [T2]: [aopOf(A3)] },
    });
    s.runner.run.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    const result = await s.job.runOnce();
    expect(result).toEqual({ skipped: false, tenants: 2, fired: 3, failed: 1 });
    expect(s.runner.run.mock.calls.map(([aop]) => aop.id)).toEqual([A1, A2, A3]);
    expect(s.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: T1, aopId: A1, errName: "Error" }),
    );

    const t = setup({ aops: { [T1]: [aopOf(A1)], [T2]: [aopOf(A3)] } });
    t.store.repo.dueAops.mockImplementationOnce(() => Promise.reject(new Error("banco")));
    expect(await t.job.runOnce()).toMatchObject({ tenants: 2, fired: 1 });
    expect(t.fired.map((f) => f.aopId)).toEqual([A3]);
  });

  it("lock perdido no meio aborta o ciclo", async () => {
    const s = setup({ aops: { [T1]: [aopOf(A1), aopOf(A2)] } });
    // antes do tenant, antes do A1, antes do A2 (perdido)
    s.lock.assertHeld
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new LockLostError(AOP_LOCK_KEY));
    await expect(s.job.runOnce()).rejects.toBeInstanceOf(LockLostError);
    expect(s.fired.map((f) => f.aopId)).toEqual([A1]);
    expect(s.lock.release).toHaveBeenCalled();
  });

  it("onlyTenants restringe o ciclo (testes compartilham o banco)", async () => {
    const s = setup({ aops: { [T1]: [aopOf(A1)], [T2]: [aopOf(A3)] } });
    expect(await s.job.runOnce({ onlyTenants: [T2] })).toMatchObject({ tenants: 1, fired: 1 });
    expect(s.fired.map((f) => f.aopId)).toEqual([A3]);
  });
});

describe("AopJob.handle (aop.run_requested)", () => {
  it("disparo manual roda com o fireAt do evento, sem tocar em last_fire_at", async () => {
    const s = setup();
    await s.job.handle(manualEvent());
    expect(s.fired).toEqual([
      { tenantId: T1, aopId: A1, opts: { fireAt: new Date(MANUAL_0901), trigger: "manual" } },
    ]);
    expect(s.store.repo.claimFire).not.toHaveBeenCalled();
  });

  it("disparo agendado vencido antes de um manual ainda roda no tick seguinte", async () => {
    const s = setup();
    await s.job.handle(manualEvent());
    expect(await s.job.runOnce()).toMatchObject({ fired: 1 });
    expect(s.fired.map((f) => f.opts)).toEqual([
      { fireAt: new Date(MANUAL_0901), trigger: "manual" },
      { fireAt: FIRE_0900, trigger: "schedule" },
    ]);
  });

  it("reentrega de aop.run_requested enquanto o primeiro roda não roda de novo", async () => {
    const s = setup();
    let finish: (() => void) | undefined;
    s.runner.run.mockImplementationOnce(
      () =>
        new Promise<AopRunSummary>((resolve) => {
          finish = () => resolve(SUMMARY);
        }),
    );
    const first = s.job.handle(manualEvent());
    await vi.waitFor(() => expect(s.runner.run).toHaveBeenCalledTimes(1));
    await s.job.handle(manualEvent()); // reentrega concorrente: lock do disparo ocupado
    expect(s.runner.run).toHaveBeenCalledTimes(1);
    expect(s.locks.acquire).toHaveBeenCalledWith(
      aopManualLockKey(A1, MANUAL_0901),
      expect.any(Number),
    );
    finish?.();
    await first;
  });

  it("reentrega depois de terminar chama o runner com o mesmo fireAt (que pula o que já rodou)", async () => {
    const s = setup();
    await s.job.handle(manualEvent());
    await s.job.handle(manualEvent());
    // a idempotência por cliente é do AopRunner (único de aop_run); o fireAt é sempre o do evento
    expect(s.fired.map((f) => f.opts.fireAt.toISOString())).toEqual([MANUAL_0901, MANUAL_0901]);
  });

  it("outros tipos são ignorados; ids inválidos, AOP inexistente ou desligado não rodam", async () => {
    const s = setup({ aops: { [T1]: [aopOf(A1), aopOf(A2, { enabled: false })] } });
    await s.job.handle({
      type: "data.ingested",
      eventId: "66666666-6666-4666-8666-666666666666",
      tenantId: T1,
      clientId: T1,
      source: "x",
    });
    await s.job.handle(manualEvent({ tenantId: "não-uuid" }));
    await s.job.handle(manualEvent({ aopId: A3 }));
    await s.job.handle(manualEvent({ aopId: A2 }));
    await s.job.handle(manualEvent({ tenantId: T2 }));
    expect(s.runner.run).not.toHaveBeenCalled();
    expect(s.logger.warn).toHaveBeenCalled();
  });

  it("falha da execução sobe (o stream reentrega; o runner não repete o que já gravou)", async () => {
    const s = setup();
    s.runner.run.mockRejectedValueOnce(new Error("tenant sumiu"));
    await expect(s.job.handle(manualEvent())).rejects.toThrow("tenant sumiu");
    // o lock do disparo foi liberado: a reentrega roda
    await s.job.handle(manualEvent());
    expect(s.runner.run).toHaveBeenCalledTimes(2);
  });
});

describe("AopJob: ciclo de vida", () => {
  it("WORKERS_ENABLED=false não liga; true liga timer e consumidor do grupo aops; stop espera", async () => {
    const off = setup({ workers: "false" });
    off.job.onApplicationBootstrap();
    expect(off.job.running).toBe(false);
    expect(off.streams.consume).not.toHaveBeenCalled();

    vi.useFakeTimers();
    const on = setup({ workers: "true" });
    on.job.onApplicationBootstrap();
    expect(on.job.running).toBe(true);
    expect(on.streams.consume).toHaveBeenCalledWith(
      expect.objectContaining({ stream: AOP_STREAM, group: AOP_GROUP }),
    );
    await vi.advanceTimersByTimeAsync(TICK);
    expect(on.runner.run).toHaveBeenCalledTimes(1);
    await on.job.onModuleDestroy();
    expect(on.job.running).toBe(false);
    vi.useRealTimers();
  });
});
