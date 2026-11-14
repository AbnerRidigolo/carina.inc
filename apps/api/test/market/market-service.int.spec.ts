/**
 * MarketService contra Redis real (DB lógico próprio, test/setup/redis-dbs.ts, esvaziado a cada
 * teste): a expiração do cache é conferida pelo CLOCK, valor corrompido vira acerto perdido e é
 * regravado, e com o Redis fora do ar o preço de servidor ainda vem do provedor.
 */
import { QuoteSchema } from "@carina/shared";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketService } from "../../src/modules/market/market.service.js";
import type { RawQuote } from "../../src/modules/market/providers/types.js";
import { redisDbUrl } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

const TEST_DB = redisDbOf("market/market-service.int.spec.ts");
/** Sexta-feira 13/11/2026 às 11:00 em São Paulo (pregão aberto). */
const T0 = Date.parse("2026-11-13T14:00:00.000Z");

const ENV = {
  MARKET_MODE: "live" as const,
  MARKET_QUOTE_MAX_AGE_MS: 300_000,
  MARKET_CLOSED_MAX_AGE_DAYS: 5,
};

function build(redis: Pick<Redis, "get" | "set">) {
  let now = T0;
  const clock = () => now;
  const fetchQuotes = vi.fn((symbols: string[]): Promise<RawQuote[]> =>
    Promise.resolve(
      symbols.map((symbol) => ({
        symbol,
        name: symbol,
        assetClass: "stock" as const,
        price: "30.00",
        changePct: null,
        previousClose: null,
        volume: null,
        currency: "BRL" as const,
        updatedAt: new Date(clock()).toISOString(),
        source: "brapi" as const,
      })),
    ),
  );
  const provider = { fetchQuotes, fetchHistory: vi.fn(() => Promise.resolve([])) };
  const macro = { fetchMacro: vi.fn(() => Promise.resolve([])) };
  const logger = { warn: vi.fn() };
  const service = new MarketService(provider, macro, redis, clock, ENV as never, logger);
  return {
    service,
    fetchQuotes,
    logger,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("MarketService (Redis real)", () => {
  let redis: Redis;

  beforeEach(async () => {
    redis = new Redis(redisDbUrl(TEST_DB));
    await redis.flushdb();
  });

  afterEach(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  it("segunda chamada em 59 999 ms não vai ao provedor e em 60 000 ms vai", async () => {
    const { service, fetchQuotes, advance } = build(redis);
    await service.quotes(["PETR4"]);
    expect(fetchQuotes).toHaveBeenCalledTimes(1);
    const ttl = await redis.pttl("market:quote:PETR4");
    expect(ttl).toBeGreaterThan(0);

    advance(59_999);
    await service.quotes(["PETR4"]);
    expect(fetchQuotes).toHaveBeenCalledTimes(1);

    advance(1);
    await service.quotes(["PETR4"]);
    expect(fetchQuotes).toHaveBeenCalledTimes(2);
  });

  it('valor corrompido (SET market:quote:PETR4 "{lixo") faz a busca ir ao provedor e regrava', async () => {
    await redis.set("market:quote:PETR4", "{lixo");
    const { service, fetchQuotes, logger } = build(redis);
    const quote = await service.priceFor("PETR4");
    expect(quote.price).toBe("30.00");
    expect(fetchQuotes).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();

    const stored = JSON.parse((await redis.get("market:quote:PETR4")) ?? "null") as {
      value: unknown;
      fetchedAt: number;
    };
    expect(stored.fetchedAt).toBe(T0);
    expect(QuoteSchema.omit({ marketState: true }).parse(stored.value)).toMatchObject({
      symbol: "PETR4",
      price: "30.00",
    });

    await service.quotes(["PETR4"]);
    expect(fetchQuotes).toHaveBeenCalledTimes(1);
  });

  it("com o Redis indisponível (cliente que lança), priceFor ainda devolve o preço do provedor", async () => {
    // Cliente real apontando para uma porta sem servidor, sem fila offline nem reconexão:
    // cada comando lança na hora. lazyConnect: nunca abre socket (nenhum handle pendurado).
    const down = new Redis({
      host: "127.0.0.1",
      port: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    try {
      await expect(down.get("x")).rejects.toThrow();
      const { service, fetchQuotes, logger } = build(down);
      const quote = await service.priceFor("PETR4");
      expect(quote).toMatchObject({ symbol: "PETR4", price: "30.00", marketState: "open" });
      expect(fetchQuotes).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: expect.any(String), err: expect.anything() }),
      );
    } finally {
      down.disconnect();
    }
  });
});
