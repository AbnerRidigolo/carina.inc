import type { PortfolioAlert, Quote } from "@carina/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantContext } from "../../core/context/tenant-context.js";
import {
  MONITOR_CURSOR_KEY,
  MONITOR_LOCK_KEY,
  MonitorJob,
  type MonitorLogger,
} from "./monitor.job.js";
import type { NewAlert, WatchItem } from "./monitor.repository.js";

// 2026-11-16 é segunda-feira; 18:00Z = 15:00 em São Paulo (pregão aberto).
const OPEN = Date.parse("2026-11-16T18:00:00.000Z");
// sábado
const CLOSED = Date.parse("2026-11-14T15:00:00.000Z");
const INTERVAL = 600_000;

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const C1 = "33333333-3333-4333-8333-333333333333";
const C2 = "44444444-4444-4444-8444-444444444444";
const C3 = "55555555-5555-4555-8555-555555555555";

const quote = (symbol: string, changePct: string | null = "0", price = "31.4"): Quote => ({
  symbol,
  name: symbol,
  assetClass: "stock",
  price,
  changePct,
  previousClose: "33",
  volume: "1000",
  currency: "BRL",
  updatedAt: "2026-11-16T17:59:00.000Z",
  marketState: "open",
  source: "mock",
});

/** Símbolos S00..S{n-1}, já em ordem. */
const symbols = (n: number) =>
  Array.from({ length: n }, (_, i) => `S${i.toString().padStart(2, "0")}`);

interface SetupOpts {
  now?: number;
  lock?: boolean;
  workers?: "true" | "false";
  maxSymbols?: number;
  watch?: Record<string, WatchItem[]>;
  moves?: Record<string, string>;
}

function setup(opts: SetupOpts = {}) {
  const order: string[] = [];
  const lock = {
    assertHeld: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(true),
  };
  const locks = {
    acquire: vi.fn(() => {
      order.push("lock");
      return Promise.resolve(opts.lock === false ? null : lock);
    }),
  };
  const store = new Map<string, string>();
  const redis = {
    get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    set: vi.fn((k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve("OK");
    }),
  };
  const watch = opts.watch ?? {
    [T1]: [
      { clientId: C1, assetCode: "PETR4" },
      { clientId: C1, assetCode: "VALE3" },
      { clientId: C2, assetCode: "PETR4" },
    ],
    [T2]: [{ clientId: C3, assetCode: "ITUB4" }],
  };
  const moves = opts.moves ?? {};
  let inTx = false;
  const fakeTx = { fake: true };
  const db = {
    tx: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      inTx = true;
      try {
        return await fn(fakeTx);
      } finally {
        inTx = false;
      }
    }),
  };
  const repo = {
    tenantIds: vi.fn(() => Promise.resolve(Object.keys(watch))),
    watchList: vi.fn((tx: unknown) => {
      expect(tx).toBe(fakeTx);
      expect(TenantContext.current().clientId).toBeUndefined();
      return Promise.resolve(watch[TenantContext.current().tenantId] ?? []);
    }),
    insertIfNew: vi.fn((tx: unknown, row: NewAlert): Promise<PortfolioAlert | null> => {
      expect(tx).toBe(fakeTx);
      return Promise.resolve({
        id: "66666666-6666-4666-8666-666666666666",
        assetCode: row.assetCode,
        direction: row.direction,
        changePct: row.changePct,
        price: row.price,
        tradingDay: row.tradingDay,
        createdAt: "2026-11-16T18:00:00.000Z",
      });
    }),
  };
  const market = {
    monitorQuotes: vi.fn((list: string[]) => {
      order.push("quotes");
      return Promise.resolve({
        quotes: list.map((s) => quote(s, moves[s] ?? "0")),
        exhausted: false,
      });
    }),
  };
  const published: { inTx: boolean; event: unknown }[] = [];
  const publish = vi.fn((_stream: string, event: unknown) => {
    published.push({ inTx, event });
    return Promise.resolve("1-0");
  });
  const logger: MonitorLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const job = new MonitorJob(
    {
      WORKERS_ENABLED: opts.workers ?? "false",
      MARKET_MODE: "mock",
      MONITOR_INTERVAL_MS: INTERVAL,
      MONITOR_MAX_SYMBOLS_PER_TICK: opts.maxSymbols ?? 20,
      MONITOR_MOVE_THRESHOLD_PCT: 5,
    },
    db as never,
    repo as never,
    market as never,
    { publish } as never,
    locks as never,
    redis as never,
    () => opts.now ?? OPEN,
    logger,
  );
  return { job, lock, locks, redis, store, db, repo, market, publish, published, logger, order };
}

/** Todas as chamadas do logger, numa string só. */
const allLogs = (logger: MonitorLogger) =>
  JSON.stringify([
    vi.mocked(logger.info).mock.calls,
    vi.mocked(logger.warn).mock.calls,
    vi.mocked(logger.error).mock.calls,
  ]);

describe("MonitorJob.runOnce", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fora do pregão não cota nem lê posições (closed=true)", async () => {
    const s = setup({ now: CLOSED });
    expect(await s.job.runOnce()).toEqual({
      skipped: false,
      closed: true,
      tenants: 0,
      symbols: 0,
      alerts: 0,
      exhausted: false,
    });
    expect(s.repo.tenantIds).not.toHaveBeenCalled();
    expect(s.repo.watchList).not.toHaveBeenCalled();
    expect(s.market.monitorQuotes).not.toHaveBeenCalled();
    expect(s.locks.acquire).not.toHaveBeenCalled();
  });

  it("lock tomado por outra réplica → skipped", async () => {
    const s = setup({ lock: false });
    expect(await s.job.runOnce()).toEqual({
      skipped: true,
      closed: false,
      tenants: 0,
      symbols: 0,
      alerts: 0,
      exhausted: false,
    });
    expect(s.locks.acquire).toHaveBeenCalledWith(MONITOR_LOCK_KEY, expect.any(Number));
    expect(s.repo.tenantIds).not.toHaveBeenCalled();
    expect(s.market.monitorQuotes).not.toHaveBeenCalled();
  });

  it("toma o lock monitor:tick antes de cotar e o libera no fim", async () => {
    const s = setup();
    await s.job.runOnce();
    expect(MONITOR_LOCK_KEY).toBe("monitor:tick");
    expect(s.order).toEqual(["lock", "quotes"]);
    expect(s.lock.assertHeld).toHaveBeenCalled();
    expect(s.lock.release).toHaveBeenCalled();
  });

  it("cota a união ordenada dos símbolos dos tenants, sem repetidos nem códigos inválidos", async () => {
    const s = setup({
      watch: {
        [T1]: [
          { clientId: C1, assetCode: "VALE3" },
          { clientId: C1, assetCode: "TESOURO-IPCA" },
          { clientId: C2, assetCode: "PETR4" },
        ],
        [T2]: [{ clientId: C3, assetCode: "PETR4" }],
      },
    });
    expect(await s.job.runOnce()).toMatchObject({ tenants: 2, symbols: 2, alerts: 0 });
    expect(s.market.monitorQuotes).toHaveBeenCalledWith(["PETR4", "VALE3"]);
  });

  it("rodízio: 45 símbolos, limite 20 → três ciclos cobrem todos, na ordem, e o quarto recomeça", async () => {
    const all = symbols(45);
    const s = setup({ watch: { [T1]: all.map((assetCode) => ({ clientId: C1, assetCode })) } });
    const runs = [];
    for (let i = 0; i < 4; i++) runs.push(await s.job.runOnce());
    const calls = s.market.monitorQuotes.mock.calls.map(([list]) => list);
    expect(calls).toEqual([all.slice(0, 20), all.slice(20, 40), all.slice(40), all.slice(0, 20)]);
    expect(runs.map((r) => r.symbols)).toEqual([20, 20, 5, 20]);
    expect(s.store.get(MONITOR_CURSOR_KEY)).toBe("S19");
    expect(MONITOR_CURSOR_KEY).toBe("monitor:cursor");
  });

  it("rodízio: símbolo do cursor que saiu da carteira não trava; segue do próximo maior", async () => {
    const s = setup({
      watch: { [T1]: ["AAA1", "CCC3", "DDD4"].map((assetCode) => ({ clientId: C1, assetCode })) },
      maxSymbols: 2,
    });
    s.store.set(MONITOR_CURSOR_KEY, "BBB2");
    await s.job.runOnce();
    expect(s.market.monitorQuotes).toHaveBeenLastCalledWith(["CCC3", "DDD4"]);
    await s.job.runOnce();
    expect(s.market.monitorQuotes).toHaveBeenLastCalledWith(["AAA1", "CCC3"]);
  });

  it("orçamento esgotado no meio: cursor para no último cotado, sem erro", async () => {
    const all = symbols(30);
    const s = setup({
      watch: { [T1]: all.map((assetCode) => ({ clientId: C1, assetCode })) },
      moves: { S03: "-6" },
    });
    s.market.monitorQuotes.mockImplementationOnce((list: string[]) =>
      Promise.resolve({
        quotes: list.slice(0, 7).map((sym) => quote(sym, sym === "S03" ? "-6" : "0")),
        exhausted: true,
      }),
    );
    const first = await s.job.runOnce();
    expect(first).toMatchObject({ skipped: false, exhausted: true, alerts: 1 });
    expect(s.store.get(MONITOR_CURSOR_KEY)).toBe("S06");
    await s.job.runOnce();
    expect(s.market.monitorQuotes).toHaveBeenLastCalledWith(all.slice(7, 27));
    expect(s.logger.error).not.toHaveBeenCalled();
  });

  it("orçamento esgotado antes de qualquer cotação: cursor não anda", async () => {
    const s = setup();
    s.store.set(MONITOR_CURSOR_KEY, "AAAA1");
    s.market.monitorQuotes.mockResolvedValueOnce({ quotes: [], exhausted: true });
    expect(await s.job.runOnce()).toMatchObject({ exhausted: true, alerts: 0 });
    expect(s.store.get(MONITOR_CURSOR_KEY)).toBe("AAAA1");
  });

  it("variação de −6% grava o alerta de cada cliente com o ativo, sob o tenant certo, e publica depois do COMMIT", async () => {
    const s = setup({ moves: { PETR4: "-6.2" } });
    expect(await s.job.runOnce()).toMatchObject({ tenants: 2, symbols: 3, alerts: 2 });
    const rows = s.repo.insertIfNew.mock.calls.map(([, row]) => row);
    expect(rows).toEqual([
      {
        clientId: C1,
        assetCode: "PETR4",
        direction: "down",
        changePct: "-6.2",
        price: "31.4",
        tradingDay: "2026-11-16",
      },
      expect.objectContaining({ clientId: C2, assetCode: "PETR4" }),
    ]);
    expect(s.publish).toHaveBeenCalledTimes(2);
    expect(s.published.every((p) => !p.inTx)).toBe(true);
    expect(s.publish.mock.calls[0]).toEqual([
      "inbox.events",
      expect.objectContaining({
        type: "monitor.alert",
        tenantId: T1,
        clientId: C1,
        alert: expect.objectContaining({ assetCode: "PETR4", direction: "down" }),
      }),
    ]);
  });

  it("alerta que já existia (insertIfNew → null) não é publicado", async () => {
    const s = setup({ moves: { ITUB4: "7" } });
    s.repo.insertIfNew.mockResolvedValue(null);
    expect(await s.job.runOnce()).toMatchObject({ alerts: 0 });
    expect(s.publish).not.toHaveBeenCalled();
  });

  it("falha num tenant é logada (só ids) e os demais seguem", async () => {
    const s = setup({ moves: { PETR4: "-6", ITUB4: "6" } });
    s.repo.watchList.mockImplementationOnce(() => Promise.reject(new Error("banco fora")));
    expect(await s.job.runOnce()).toMatchObject({ tenants: 2, alerts: 1 });
    expect(s.repo.insertIfNew).toHaveBeenCalledTimes(1);
    expect(s.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: T1, errName: "Error" }),
    );
    expect(allLogs(s.logger)).not.toContain("banco fora");
  });

  it("falha num insert é logada (só ids) e os demais alertas do tenant seguem", async () => {
    const s = setup({ moves: { PETR4: "-6", VALE3: "8" } });
    s.repo.insertIfNew.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("numeric field overflow"), { code: "22003" })),
    );
    expect(await s.job.runOnce()).toMatchObject({ alerts: 2 });
    expect(s.repo.insertIfNew).toHaveBeenCalledTimes(3);
    // cada alerta na sua transação: a falha de um não aborta os outros
    expect(s.db.tx.mock.calls.length).toBeGreaterThanOrEqual(3 + 2);
    expect(s.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: T1, clientId: C1, errCode: "22003" }),
    );
  });

  it("falha ao publicar só é logada", async () => {
    const s = setup({ moves: { ITUB4: "6" } });
    s.publish.mockRejectedValue(new Error("redis fora"));
    expect(await s.job.runOnce()).toMatchObject({ alerts: 1 });
    expect(s.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: T2, clientId: C3 }),
    );
  });

  it("lock perdido antes de gravar aborta o ciclo", async () => {
    const s = setup({ moves: { PETR4: "-6" } });
    s.lock.assertHeld
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("perdido"), { name: "LockLostError" }));
    await expect(s.job.runOnce()).rejects.toThrow("perdido");
    expect(s.repo.insertIfNew).not.toHaveBeenCalled();
    expect(s.lock.release).toHaveBeenCalled();
  });

  it("nenhum log contém valor de posição", async () => {
    const s = setup({ moves: { PETR4: "-6.2", ITUB4: "9.5" } });
    s.repo.insertIfNew.mockImplementationOnce(() => Promise.reject(new Error("PETR4 -6.2 31.4")));
    s.publish.mockRejectedValueOnce(new Error("ITUB4 9.5"));
    await s.job.runOnce();
    const logs = allLogs(s.logger);
    for (const leaked of ["PETR4", "VALE3", "ITUB4", "31.4", "-6.2", "9.5"]) {
      expect(logs).not.toContain(leaked);
    }
    const allowed = new Set([
      "msg",
      "errName",
      "errCode",
      "tenantId",
      "clientId",
      "tenants",
      "symbols",
      "alerts",
      "exhausted",
    ]);
    for (const fn of [s.logger.info, s.logger.warn, s.logger.error]) {
      for (const [fields] of vi.mocked(fn).mock.calls) {
        for (const key of Object.keys(fields)) expect(allowed.has(key), key).toBe(true);
      }
    }
    expect(s.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenants: 2, symbols: 3, alerts: 2 }),
    );
  });
});

describe("MonitorJob: ciclo de vida", () => {
  it("WORKERS_ENABLED=false não liga o timer", () => {
    const s = setup();
    s.job.onApplicationBootstrap();
    expect(s.job.running).toBe(false);
  });

  it("timer de MONITOR_INTERVAL_MS unref; um ciclo por vez; stop espera o ciclo", async () => {
    vi.useFakeTimers();
    const s = setup({ workers: "true" });
    let release!: () => void;
    s.repo.tenantIds.mockImplementation(
      () => new Promise<string[]>((r) => (release = () => r([]))),
    );
    s.job.onApplicationBootstrap();
    s.job.start();
    expect(s.job.running).toBe(true);
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(s.locks.acquire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(s.locks.acquire).toHaveBeenCalledTimes(1);
    const stopped = s.job.onModuleDestroy();
    release();
    await stopped;
    await s.job.beforeApplicationShutdown();
    expect(s.job.running).toBe(false);
    vi.useRealTimers();
  });

  it("ciclo que falha é logado", async () => {
    vi.useFakeTimers();
    const s = setup({ workers: "true" });
    s.locks.acquire.mockRejectedValue(new Error("redis"));
    s.job.start();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(s.logger.error).toHaveBeenCalledWith(expect.objectContaining({ errName: "Error" }));
    await s.job.stop();
    vi.useRealTimers();
  });
});
