import type { PortfolioAlert, Quote } from "@carina/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantContext } from "../../core/context/tenant-context.js";
import { MarketDataUnavailableError } from "../../core/errors/domain-errors.js";
import { MarketService } from "../market/market.service.js";
import type { RawQuote } from "../market/providers/types.js";
import {
  MONITOR_LOCK_KEY,
  MonitorJob,
  type MonitorLogger,
  monitorCursorKey,
} from "./monitor.job.js";
import type { NewAlert, WatchItem } from "./monitor.repository.js";

// 2026-11-16 é segunda-feira; 18:00Z = 15:00 em São Paulo (pregão aberto).
const OPEN = Date.parse("2026-11-16T18:00:00.000Z");
// sábado
const CLOSED = Date.parse("2026-11-14T15:00:00.000Z");
const INTERVAL = 600_000;
/** Cursor do rodízio no modo dos testes (mock). */
const MONITOR_CURSOR_KEY = monitorCursorKey("mock");

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

/**
 * `monitorQuotes` falso com a semântica do real: cache não gasta orçamento; cada símbolo fora do
 * cache gasta uma tentativa (1 símbolo por chamada); desconhecido tentado volta ausente; o que não
 * coube no orçamento fica em `pending`.
 */
function budgetMarket(opts: { budget: number; unknown?: string[]; cached?: string[] }) {
  return (list: string[]) => {
    let left = opts.budget;
    const quotes: Quote[] = [];
    const pending: string[] = [];
    for (const sym of list) {
      if (opts.cached?.includes(sym)) {
        quotes.push(quote(sym));
      } else if (pending.length === 0 && left > 0) {
        left--;
        if (!opts.unknown?.includes(sym)) quotes.push(quote(sym));
      } else {
        pending.push(sym);
      }
    }
    return Promise.resolve({ quotes, exhausted: pending.length > 0, pending });
  };
}

interface SetupOpts {
  now?: number;
  mode?: "live" | "mock";
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
        pending: [] as string[],
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
      MARKET_MODE: opts.mode ?? "mock",
      MARKET_QUOTE_MAX_AGE_MS: 300_000,
      MONITOR_INTERVAL_MS: INTERVAL,
      MONITOR_MAX_SYMBOLS_PER_TICK: opts.maxSymbols ?? 10,
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
    const s = setup({
      watch: { [T1]: all.map((assetCode) => ({ clientId: C1, assetCode })) },
      maxSymbols: 20,
    });
    const runs = [];
    for (let i = 0; i < 4; i++) runs.push(await s.job.runOnce());
    const calls = s.market.monitorQuotes.mock.calls.map(([list]) => list);
    expect(calls).toEqual([all.slice(0, 20), all.slice(20, 40), all.slice(40), all.slice(0, 20)]);
    expect(runs.map((r) => r.symbols)).toEqual([20, 20, 5, 20]);
    expect(s.store.get(MONITOR_CURSOR_KEY)).toBe("S19");
  });

  it("cursor do rodízio é por modo: monitor:<modo>:cursor", async () => {
    expect(monitorCursorKey("mock")).toBe("monitor:mock:cursor");
    expect(monitorCursorKey("live")).toBe("monitor:live:cursor");
    // o job live não lê nem grava o cursor do mock
    const s = setup({ mode: "live" });
    s.store.set("monitor:mock:cursor", "PETR4");
    await s.job.runOnce();
    expect(s.market.monitorQuotes).toHaveBeenLastCalledWith(["ITUB4", "PETR4", "VALE3"]);
    expect(s.store.get("monitor:live:cursor")).toBe("VALE3");
    expect(s.store.get("monitor:mock:cursor")).toBe("PETR4");
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
      maxSymbols: 20,
    });
    s.market.monitorQuotes.mockImplementationOnce((list: string[]) =>
      Promise.resolve({
        quotes: list.slice(0, 7).map((sym) => quote(sym, sym === "S03" ? "-6" : "0")),
        exhausted: true,
        pending: list.slice(7),
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
    s.market.monitorQuotes.mockImplementationOnce((list: string[]) =>
      Promise.resolve({ quotes: [], exhausted: true, pending: list }),
    );
    expect(await s.job.runOnce()).toMatchObject({ exhausted: true, alerts: 0 });
    expect(s.store.get(MONITOR_CURSOR_KEY)).toBe("AAAA1");
  });

  it("símbolo desconhecido do provedor no começo do lote não trava o rodízio (orçamento esgotado)", async () => {
    const all = symbols(30);
    const s = setup({ watch: { [T1]: all.map((assetCode) => ({ clientId: C1, assetCode })) } });
    // S00 não existe no provedor; sem cache (o negativo expira entre ciclos); 3 tentativas por ciclo
    s.market.monitorQuotes.mockImplementation(budgetMarket({ budget: 3, unknown: ["S00"] }));
    for (let i = 0; i < 3; i++) await s.job.runOnce();
    const calls = s.market.monitorQuotes.mock.calls.map(([list]) => list);
    expect(calls).toEqual([all.slice(0, 10), all.slice(3, 13), all.slice(6, 16)]);
    expect(s.store.get(MONITOR_CURSOR_KEY)).toBe("S08");
  });

  it("símbolo desconhecido no meio do lote: o cursor passa por ele", async () => {
    const all = symbols(30);
    const s = setup({ watch: { [T1]: all.map((assetCode) => ({ clientId: C1, assetCode })) } });
    // sem esgotar: o lote inteiro foi tentado
    s.market.monitorQuotes.mockImplementationOnce(budgetMarket({ budget: 99, unknown: ["S05"] }));
    expect(await s.job.runOnce()).toMatchObject({ exhausted: false, symbols: 10 });
    expect(s.store.get(MONITOR_CURSOR_KEY)).toBe("S09");
    // esgotando depois dele: para no último tentado, não antes do desconhecido
    s.market.monitorQuotes.mockImplementationOnce(budgetMarket({ budget: 5, unknown: ["S12"] }));
    expect(await s.job.runOnce()).toMatchObject({ exhausted: true });
    expect(s.store.get(MONITOR_CURSOR_KEY)).toBe("S14");
  });

  it("erro do provedor num símbolo não trava o rodízio", async () => {
    const all = symbols(30);
    const s = setup({
      watch: { [T1]: all.map((assetCode) => ({ clientId: C1, assetCode })) },
      moves: { S02: "-6" },
    });
    // MarketService de verdade (1 símbolo por chamada): o provedor falha sempre em S01
    const fetchQuotes = vi.fn((list: string[]): Promise<RawQuote[]> => {
      if (list.includes("S01")) return Promise.reject(new MarketDataUnavailableError());
      return Promise.resolve(
        list.map((sym): RawQuote => {
          const raw: Partial<Quote> = quote(sym, sym === "S02" ? "-6" : "0");
          delete raw.marketState;
          return raw as RawQuote;
        }),
      );
    });
    const counters = new Map<string, number>();
    const service = new MarketService(
      { fetchQuotes, fetchHistory: vi.fn() },
      { fetchMacro: vi.fn() },
      {
        get: () => Promise.resolve(null), // sem cache: cada ciclo vai ao provedor
        set: () => Promise.resolve("OK"),
        eval: (_script: string, _n: number, key: string, units: string) => {
          const next = (counters.get(key) ?? 0) + Number(units);
          counters.set(key, next);
          return Promise.resolve(next);
        },
      } as never,
      () => OPEN,
      {
        NODE_ENV: "test",
        MARKET_MODE: "mock",
        MARKET_QUOTE_MAX_AGE_MS: 300_000,
        MARKET_CLOSED_MAX_AGE_DAYS: 5,
        MARKET_BRAPI_MAX_SYMBOLS_PER_CALL: 1,
        MARKET_PROVIDER_MAX_CALLS_PER_MIN: 30,
        MARKET_PRICE_MAX_CALLS_PER_MIN: 30,
        MARKET_MONITOR_MAX_CALLS_PER_MIN: 99,
      },
      { warn: vi.fn() },
    );
    s.market.monitorQuotes.mockImplementation((list: string[]) => service.monitorQuotes(list));
    // o ciclo não falha, o cursor passa por S01 e o alerta de S02 (no mesmo lote) sai
    expect(await s.job.runOnce()).toMatchObject({ symbols: 10, alerts: 1, exhausted: false });
    expect(s.store.get(MONITOR_CURSOR_KEY)).toBe("S09");
    await s.job.runOnce();
    const calls = s.market.monitorQuotes.mock.calls.map(([list]) => list);
    expect(calls).toEqual([all.slice(0, 10), all.slice(10, 20)]);
    expect(s.logger.error).not.toHaveBeenCalled();
  });

  it("cache expirado entre ciclos não faz o rodízio repetir a mesma janela", async () => {
    const all = symbols(30);
    const s = setup({ watch: { [T1]: all.map((assetCode) => ({ clientId: C1, assetCode })) } });
    // 1º ciclo: S05..S09 já no cache (vindos das rotas), S00 desconhecido, 2 tentativas
    s.market.monitorQuotes.mockImplementationOnce(
      budgetMarket({ budget: 2, unknown: ["S00"], cached: all.slice(5, 10) }),
    );
    expect(await s.job.runOnce()).toMatchObject({ exhausted: true });
    // nada pulado: S02..S04 não foram tentados, apesar de S05..S09 terem voltado do cache
    expect(s.store.get(MONITOR_CURSOR_KEY)).toBe("S01");
    // 2º ciclo: o cache expirou (inclusive o negativo de S00), 2 tentativas de novo
    s.market.monitorQuotes.mockImplementationOnce(budgetMarket({ budget: 2, unknown: ["S00"] }));
    await s.job.runOnce();
    expect(s.store.get(MONITOR_CURSOR_KEY)).toBe("S03");
    const calls = s.market.monitorQuotes.mock.calls.map(([list]) => list);
    expect(calls).toEqual([all.slice(0, 10), all.slice(2, 12)]);
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

  it("cotação do pregão anterior ou velha demais não vira alerta de hoje", async () => {
    const s = setup({ moves: { PETR4: "-6.2", ITUB4: "7" } });
    s.market.monitorQuotes.mockImplementationOnce((list: string[]) =>
      Promise.resolve({
        quotes: list.map((sym) => ({
          ...quote(sym, sym === "VALE3" ? "0" : "-6.2"),
          // PETR4: fechamento de sexta; ITUB4: hoje, mas 30 min atrás (atraso do plano gratuito)
          updatedAt:
            sym === "PETR4"
              ? "2026-11-13T20:59:00.000Z"
              : new Date(OPEN - 30 * 60_000).toISOString(),
        })),
        exhausted: false,
        pending: [] as string[],
      }),
    );
    expect(await s.job.runOnce()).toMatchObject({ alerts: 0 });
    expect(s.repo.insertIfNew).not.toHaveBeenCalled();
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
    // a segunda conferência é antes de gravar o cursor: nem cursor nem alerta
    expect(s.store.has(MONITOR_CURSOR_KEY)).toBe(false);
    expect(s.repo.insertIfNew).not.toHaveBeenCalled();
    expect(s.lock.release).toHaveBeenCalled();
  });

  it("carteira sem símbolo válido: ciclo sem cotar, e o resumo também é logado", async () => {
    const s = setup({ watch: { [T1]: [{ clientId: C1, assetCode: "TESOURO-IPCA" }] } });
    expect(await s.job.runOnce()).toMatchObject({ tenants: 1, symbols: 0, alerts: 0 });
    expect(s.market.monitorQuotes).not.toHaveBeenCalled();
    expect(s.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ tenants: 1, symbols: 0, alerts: 0, exhausted: false }),
    );
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
