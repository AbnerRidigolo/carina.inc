/**
 * MarketService com provedores e Redis falsos e relógio controlado: uma busca por vez por chave,
 * validação de entrada, cache conferido contra o CLOCK e `priceFor` falhando fechado (ativo
 * ausente, provedor fora do ar, cotação velha ou com hora futura). O preço nunca depende do cache.
 */
import type { HistoricalBar, MacroIndicator } from "@carina/shared";
import { describe, expect, it, vi } from "vitest";
import { MarketDataUnavailableError, ValidationError } from "../../core/errors/domain-errors.js";
import { MarketPriceError } from "./market-price-error.js";
import { type MarketLogger, MarketService } from "./market.service.js";
import type { MacroProvider, MarketDataProvider, RawQuote } from "./providers/types.js";

const MIN = 60_000;
const DAY = 86_400_000;
/** Sexta-feira 13/11/2026 às 11:00 em São Paulo (pregão aberto). */
const FRIDAY_OPEN = Date.parse("2026-11-13T14:00:00.000Z");
/** Sábado 14/11/2026 às 12:00 em São Paulo (mercado fechado). */
const SATURDAY_NOON = Date.parse("2026-11-14T15:00:00.000Z");

function rawQuote(symbol: string, updatedAtMs: number, price = "30.00"): RawQuote {
  return {
    symbol,
    name: symbol,
    assetClass: "stock",
    price,
    changePct: "0.50",
    previousClose: "29.85",
    volume: "1000",
    currency: "BRL",
    updatedAt: new Date(updatedAtMs).toISOString(),
    source: "brapi",
  };
}

class FakeRedis {
  readonly store = new Map<string, string>();
  get = vi.fn((key: string) => Promise.resolve(this.store.get(key) ?? null));
  set = vi.fn((key: string, value: string) => {
    this.store.set(key, value);
    return Promise.resolve("OK" as const);
  });
}

interface SetupOptions {
  mode?: "live" | "mock";
  now?: number;
  quotes?: (symbols: string[]) => Promise<RawQuote[]>;
  redis?: { get: (key: string) => Promise<string | null>; set: (...args: unknown[]) => unknown };
}

function setup(opts: SetupOptions = {}) {
  let now = opts.now ?? FRIDAY_OPEN;
  const clock = () => now;
  const advance = (ms: number) => {
    now += ms;
  };
  const provider = {
    fetchQuotes: vi.fn(
      opts.quotes ??
        ((symbols: string[]) =>
          Promise.resolve(
            symbols.filter((s) => s !== "XXXX3").map((s) => rawQuote(s, clock() - 1000)),
          )),
    ),
    fetchHistory: vi.fn((): Promise<HistoricalBar[]> =>
      Promise.resolve([
        {
          date: "2026-11-13",
          open: "29.00",
          high: "31.00",
          low: "28.50",
          close: "30.00",
          volume: "100",
        },
      ]),
    ),
  } satisfies MarketDataProvider;
  const macroProvider = {
    fetchMacro: vi.fn((): Promise<MacroIndicator[]> =>
      Promise.resolve([
        { code: "selic", name: "Selic", value: "14.75", unit: "% a.a.", referenceDate: "x" },
      ]),
    ),
  } satisfies MacroProvider;
  const redis = opts.redis ?? new FakeRedis();
  const logger: MarketLogger = { warn: vi.fn() };
  const env = {
    MARKET_MODE: opts.mode ?? ("live" as const),
    MARKET_QUOTE_MAX_AGE_MS: 300_000,
    MARKET_CLOSED_MAX_AGE_DAYS: 5,
  };
  const service = new MarketService(
    provider,
    macroProvider,
    redis as never,
    clock,
    env as never,
    logger,
  );
  return { service, provider, macroProvider, redis, logger, clock, advance };
}

async function priceError(p: Promise<unknown>): Promise<MarketPriceError> {
  const err = await p.then(
    () => {
      throw new Error("esperava MarketPriceError");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MarketPriceError);
  return err as MarketPriceError;
}

describe("MarketService.quotes", () => {
  it("30 chamadas concorrentes de quotes(['PETR4']) chamam o provedor uma vez", async () => {
    const { service, provider } = setup();
    const results = await Promise.all(Array.from({ length: 30 }, () => service.quotes(["PETR4"])));
    expect(provider.fetchQuotes).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r.map((q) => q.symbol)).toEqual(["PETR4"]);
  });

  it("sem cache (Redis lançando), 30 chamadas concorrentes ainda chamam o provedor uma vez", async () => {
    const failing = {
      get: vi.fn(() => Promise.reject(new Error("redis down"))),
      set: vi.fn(() => Promise.reject(new Error("redis down"))),
    };
    const { service, provider } = setup({ redis: failing });
    await Promise.all(Array.from({ length: 30 }, () => service.quotes(["PETR4"])));
    expect(provider.fetchQuotes).toHaveBeenCalledTimes(1);
  });

  it("a promessa compartilhada sai ao terminar, inclusive em erro: a chamada seguinte busca de novo", async () => {
    let fail = true;
    const { service, provider } = setup({
      redis: {
        get: () => Promise.resolve(null),
        set: () => Promise.resolve("OK"),
      },
      quotes: (symbols) =>
        fail
          ? Promise.reject(new MarketDataUnavailableError())
          : Promise.resolve(symbols.map((s) => rawQuote(s, FRIDAY_OPEN))),
    });
    const failed = await Promise.allSettled([service.quotes(["PETR4"]), service.quotes(["PETR4"])]);
    expect(failed.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(provider.fetchQuotes).toHaveBeenCalledTimes(1);
    fail = false;
    await expect(service.quotes(["PETR4"])).resolves.toHaveLength(1);
    expect(provider.fetchQuotes).toHaveBeenCalledTimes(2);
  });

  it("busca os símbolos que faltam numa chamada só e omite o ausente do provedor", async () => {
    const { service, provider } = setup();
    const result = await service.quotes(["PETR4", "XXXX3", "VALE3"]);
    expect(result.map((q) => q.symbol)).toEqual(["PETR4", "VALE3"]);
    expect(provider.fetchQuotes).toHaveBeenCalledTimes(1);
    expect(provider.fetchQuotes).toHaveBeenCalledWith(["PETR4", "XXXX3", "VALE3"]);
  });

  it("símbolo repetido vira um só", async () => {
    const { service, provider } = setup();
    const result = await service.quotes(["PETR4", "PETR4"]);
    expect(result.map((q) => q.symbol)).toEqual(["PETR4"]);
    expect(provider.fetchQuotes).toHaveBeenCalledWith(["PETR4"]);
  });

  it.each([
    ["vazio", []],
    ["21 símbolos", Array.from({ length: 21 }, (_, i) => `AAAA${i + 1}`)],
    ["minúsculo", ["petr4"]],
    ["caminho", ["PETR4/../x"]],
    ["codificado", ["%2e"]],
    ["string vazia", [""]],
    ["caractere de controle", ["PETR4\n"]],
  ])("entrada inválida (%s) lança ValidationError sem chamar o provedor", async (_, symbols) => {
    const { service, provider, redis } = setup();
    await expect(service.quotes(symbols)).rejects.toBeInstanceOf(ValidationError);
    expect(provider.fetchQuotes).not.toHaveBeenCalled();
    expect((redis as FakeRedis).get).not.toHaveBeenCalled();
  });

  it("marketState: live usa o pregão do relógio; mock é sempre open", async () => {
    const live = setup({ now: SATURDAY_NOON });
    expect((await live.service.quotes(["PETR4"]))[0]?.marketState).toBe("closed");
    const liveOpen = setup({ now: FRIDAY_OPEN });
    expect((await liveOpen.service.quotes(["PETR4"]))[0]?.marketState).toBe("open");
    const mock = setup({ mode: "mock", now: SATURDAY_NOON });
    expect((await mock.service.quotes(["PETR4"]))[0]?.marketState).toBe("open");
  });

  it("acerto de cache dura até 60 s pelo CLOCK; cache com fetchedAt no futuro é ignorado", async () => {
    const { service, provider, advance, redis } = setup();
    await service.quotes(["PETR4"]);
    advance(MIN - 1);
    await service.quotes(["PETR4"]);
    expect(provider.fetchQuotes).toHaveBeenCalledTimes(1);
    advance(1);
    await service.quotes(["PETR4"]);
    expect(provider.fetchQuotes).toHaveBeenCalledTimes(2);

    const store = (redis as FakeRedis).store;
    store.set(
      "market:quote:PETR4",
      JSON.stringify({ value: rawQuote("PETR4", FRIDAY_OPEN), fetchedAt: FRIDAY_OPEN + 10 * MIN }),
    );
    await service.quotes(["PETR4"]);
    expect(provider.fetchQuotes).toHaveBeenCalledTimes(3);
  });

  it("valor de cache de outro símbolo ou fora do formato é acerto perdido com log warn", async () => {
    const { service, provider, redis, logger } = setup();
    const store = (redis as FakeRedis).store;
    store.set(
      "market:quote:PETR4",
      JSON.stringify({ value: rawQuote("VALE3", FRIDAY_OPEN), fetchedAt: FRIDAY_OPEN }),
    );
    await service.quotes(["PETR4"]);
    store.set(
      "market:quote:PETR4",
      JSON.stringify({ value: { ...rawQuote("PETR4", FRIDAY_OPEN), price: "-1" }, fetchedAt: 0 }),
    );
    await service.quotes(["PETR4"]);
    expect(provider.fetchQuotes).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("MarketService.history e macro", () => {
  it("history valida símbolo e faixa, cacheia por 600 s e tem uma busca por vez", async () => {
    const { service, provider, advance } = setup();
    await expect(service.history("petr4", "3mo")).rejects.toBeInstanceOf(ValidationError);
    await expect(service.history("PETR4", "10y" as never)).rejects.toBeInstanceOf(ValidationError);
    await Promise.all(Array.from({ length: 10 }, () => service.history("PETR4", "3mo")));
    expect(provider.fetchHistory).toHaveBeenCalledTimes(1);
    expect(provider.fetchHistory).toHaveBeenCalledWith("PETR4", "3mo");
    advance(600_000 - 1);
    await service.history("PETR4", "3mo");
    expect(provider.fetchHistory).toHaveBeenCalledTimes(1);
    await service.history("PETR4", "1y");
    expect(provider.fetchHistory).toHaveBeenCalledTimes(2);
    advance(1);
    await service.history("PETR4", "3mo");
    expect(provider.fetchHistory).toHaveBeenCalledTimes(3);
  });

  it("macro cacheia por 3600 s e tem uma busca por vez", async () => {
    const { service, macroProvider, advance } = setup();
    const [first] = await Promise.all(Array.from({ length: 10 }, () => service.macro()));
    expect(first?.[0]?.code).toBe("selic");
    expect(macroProvider.fetchMacro).toHaveBeenCalledTimes(1);
    advance(3_600_000 - 1);
    await service.macro();
    expect(macroProvider.fetchMacro).toHaveBeenCalledTimes(1);
    advance(1);
    await service.macro();
    expect(macroProvider.fetchMacro).toHaveBeenCalledTimes(2);
  });
});

describe("MarketService.priceFor", () => {
  it("mercado aberto: aceita cotação de exatamente 5 min e recusa com 5 min + 1 ms", async () => {
    const ok = setup({
      quotes: (s) => Promise.resolve(s.map((sym) => rawQuote(sym, FRIDAY_OPEN - 5 * MIN))),
    });
    const quote = await ok.service.priceFor("PETR4");
    expect(quote).toMatchObject({ symbol: "PETR4", price: "30.00", marketState: "open" });

    const stale = setup({
      quotes: (s) => Promise.resolve(s.map((sym) => rawQuote(sym, FRIDAY_OPEN - 5 * MIN - 1))),
    });
    expect((await priceError(stale.service.priceFor("PETR4"))).code).toBe("price_stale");
  });

  it("mercado fechado (sábado 12:00 SP): aceita fechamento de exatamente 5 dias e recusa com 5 dias + 1 ms", async () => {
    const ok = setup({
      now: SATURDAY_NOON,
      quotes: (s) => Promise.resolve(s.map((sym) => rawQuote(sym, SATURDAY_NOON - 5 * DAY))),
    });
    const quote = await ok.service.priceFor("PETR4");
    expect(quote.marketState).toBe("closed");
    expect(quote.updatedAt).toBe(new Date(SATURDAY_NOON - 5 * DAY).toISOString());

    const stale = setup({
      now: SATURDAY_NOON,
      quotes: (s) => Promise.resolve(s.map((sym) => rawQuote(sym, SATURDAY_NOON - 5 * DAY - 1))),
    });
    expect((await priceError(stale.service.priceFor("PETR4"))).code).toBe("price_stale");
  });

  it("mercado aberto não aceita a tolerância de fechado (cotação de 1 dia com pregão aberto)", async () => {
    const { service } = setup({
      quotes: (s) => Promise.resolve(s.map((sym) => rawQuote(sym, FRIDAY_OPEN - DAY))),
    });
    expect((await priceError(service.priceFor("PETR4"))).code).toBe("price_stale");
  });

  it("hora da cotação no futuro (idade negativa) é recusada como price_stale", async () => {
    const { service } = setup({
      quotes: (s) => Promise.resolve(s.map((sym) => rawQuote(sym, FRIDAY_OPEN + 1))),
    });
    expect((await priceError(service.priceFor("PETR4"))).code).toBe("price_stale");
  });

  it("ativo ausente do provedor → unknown_asset; símbolo malformado também, sem chamar o provedor", async () => {
    const { service, provider } = setup();
    expect((await priceError(service.priceFor("XXXX3"))).code).toBe("unknown_asset");
    expect(provider.fetchQuotes).toHaveBeenCalledTimes(1);
    expect((await priceError(service.priceFor("petr4"))).code).toBe("unknown_asset");
    expect((await priceError(service.priceFor("PETR4/../x"))).code).toBe("unknown_asset");
    expect(provider.fetchQuotes).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["MarketDataUnavailableError", new MarketDataUnavailableError()],
    ["erro qualquer", new TypeError("fetch failed")],
  ])("provedor lançando (%s) → price_unavailable", async (_, error) => {
    const { service } = setup({ quotes: () => Promise.reject(error) });
    const err = await priceError(service.priceFor("PETR4"));
    expect(err.code).toBe("price_unavailable");
    expect(err.message).not.toContain("fetch failed");
  });

  it("cotação velha em cache válido não parece nova: o frescor é medido sobre updatedAt", async () => {
    const { service, provider, redis } = setup();
    // fetchedAt agora (cache válido), mas a cotação é de 10 min atrás.
    (redis as FakeRedis).store.set(
      "market:quote:PETR4",
      JSON.stringify({ value: rawQuote("PETR4", FRIDAY_OPEN - 10 * MIN), fetchedAt: FRIDAY_OPEN }),
    );
    expect((await priceError(service.priceFor("PETR4"))).code).toBe("price_stale");
    expect(provider.fetchQuotes).not.toHaveBeenCalled();
  });

  it("não usa cache cujo fetchedAt + 60 s expirou: vai ao provedor e devolve a cotação dele", async () => {
    const { service, provider, redis } = setup({
      quotes: (s) => Promise.resolve(s.map((sym) => rawQuote(sym, FRIDAY_OPEN - 1000, "31.00"))),
    });
    (redis as FakeRedis).store.set(
      "market:quote:PETR4",
      JSON.stringify({
        value: rawQuote("PETR4", FRIDAY_OPEN - MIN, "29.00"),
        fetchedAt: FRIDAY_OPEN - MIN,
      }),
    );
    const quote = await service.priceFor("PETR4");
    expect(provider.fetchQuotes).toHaveBeenCalledTimes(1);
    expect(quote.price).toBe("31.00");
  });

  it("modo mock: estado sempre open, mesmo no sábado", async () => {
    const { service } = setup({
      mode: "mock",
      now: SATURDAY_NOON,
      quotes: (s) => Promise.resolve(s.map((sym) => rawQuote(sym, SATURDAY_NOON))),
    });
    expect((await service.priceFor("PETR4")).marketState).toBe("open");
  });

  it("Redis lançando em get e set: o preço vem do provedor, com log warn e sem erro", async () => {
    const failing = {
      get: vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
      set: vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    };
    const { service, logger } = setup({ redis: failing });
    await expect(service.priceFor("PETR4")).resolves.toMatchObject({ price: "30.00" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.any(String), err: expect.any(Error) }),
    );
  });

  it("Redis lançando de forma síncrona: o preço vem do provedor", async () => {
    const throwing = {
      get: () => {
        throw new Error("sync boom");
      },
      set: () => {
        throw new Error("sync boom");
      },
    };
    const { service } = setup({ redis: throwing as never });
    await expect(service.priceFor("PETR4")).resolves.toMatchObject({ price: "30.00" });
  });

  it("Redis pendurado (nunca responde): o preço vem do provedor dentro do limite do cache", async () => {
    const hanging = {
      get: () => new Promise<string | null>(() => {}),
      set: () => new Promise(() => {}),
    };
    const { service } = setup({ redis: hanging });
    const started = Date.now();
    await expect(service.priceFor("PETR4")).resolves.toMatchObject({ price: "30.00" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("valor corrompido no cache: acerto perdido, preço do provedor", async () => {
    const { service, provider, redis, logger } = setup();
    (redis as FakeRedis).store.set("market:quote:PETR4", "{lixo");
    await expect(service.priceFor("PETR4")).resolves.toMatchObject({ price: "30.00" });
    expect(provider.fetchQuotes).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});
