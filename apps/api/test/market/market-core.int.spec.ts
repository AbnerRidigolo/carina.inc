/**
 * Fiação do MarketCoreModule (sem rede): `mock` constrói só o MockMarketProvider; `live` liga
 * BrapiProvider/BcbProvider com os valores do ENV (token no cabeçalho, URLs base, limite de bytes).
 * O `fetch` global é trocado por um falso; Redis: DB lógico próprio (test/setup/redis-dbs.ts).
 */
import { Test, type TestingModule } from "@nestjs/testing";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigModule, ENV } from "../../src/core/config/config.module.js";
import { loadEnv } from "../../src/core/config/env.js";
import { MarketDataUnavailableError } from "../../src/core/errors/domain-errors.js";
import { MarketCoreModule } from "../../src/modules/market/market-core.module.js";
import {
  MACRO_PROVIDER,
  MARKET_DATA_PROVIDER,
  MarketService,
} from "../../src/modules/market/market.service.js";
import { BcbProvider } from "../../src/modules/market/providers/bcb.provider.js";
import { BrapiProvider } from "../../src/modules/market/providers/brapi.provider.js";
import { MockMarketProvider } from "../../src/modules/market/providers/mock.provider.js";
import { appUrl, migratorUrl, redisDbUrl } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

const REDIS_DB = redisDbOf("market/market-core.int.spec.ts");
const TOKEN = "tok-secreto-123";
const BRAPI_BASE = "https://brapi.test.invalid/api";
const BCB_BASE = "https://bcb.test.invalid/dados/serie";

const QUOTE = JSON.stringify({
  results: [
    {
      symbol: "PETR4",
      shortName: "PETROBRAS PN",
      currency: "BRL",
      regularMarketPrice: 36.65,
      regularMarketChangePercent: -0.95,
      regularMarketPreviousClose: 36.7,
      regularMarketVolume: 27681100,
      regularMarketTime: "2026-02-08T16:24:54.000Z",
    },
  ],
});

async function boot(extra: Record<string, string>): Promise<TestingModule> {
  const env = loadEnv({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: appUrl(),
    MIGRATION_DATABASE_URL: migratorUrl(),
    REDIS_URL: redisDbUrl(REDIS_DB),
    LLM_MODE: "mock",
    LOG_LEVEL: "silent",
    ...extra,
  });
  const ref = await Test.createTestingModule({ imports: [ConfigModule, MarketCoreModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .compile();
  await ref.init();
  return ref;
}

describe("MarketCoreModule: escolha do provedor", () => {
  let ref: TestingModule | undefined;
  let redis: Redis;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(async () => {
    redis = new Redis(redisDbUrl(REDIS_DB));
    await redis.flushdb();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await ref?.close();
    ref = undefined;
    await redis.quit();
    vi.unstubAllGlobals();
  });

  it("mock: ambos os tokens são MockMarketProvider; live não é construído e a rede não é tocada", async () => {
    ref = await boot({ MARKET_MODE: "mock" });
    expect(ref.get(MARKET_DATA_PROVIDER)).toBeInstanceOf(MockMarketProvider);
    expect(ref.get(MACRO_PROVIDER)).toBeInstanceOf(MockMarketProvider);
    expect(() => ref?.get(BrapiProvider, { strict: false })).toThrow();
    expect(() => ref?.get(BcbProvider, { strict: false })).toThrow();
    const svc = ref.get(MarketService);
    expect(await svc.quotes(["PETR4"])).toHaveLength(1);
    expect(await svc.macro()).toHaveLength(4);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("live: Brapi e BCB ligados ao ENV (token no cabeçalho, hosts das URLs base)", async () => {
    ref = await boot({
      MARKET_MODE: "live",
      BRAPI_TOKEN: TOKEN,
      BRAPI_BASE_URL: BRAPI_BASE,
      BCB_SGS_BASE_URL: BCB_BASE,
    });
    expect(ref.get(MARKET_DATA_PROVIDER)).toBeInstanceOf(BrapiProvider);
    expect(ref.get(MACRO_PROVIDER)).toBeInstanceOf(BcbProvider);
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        new Response(
          String(input).includes("brapi") ? QUOTE : '[{"data":"01/10/2026","valor":"5.4"}]',
        ),
      ),
    );
    const svc = ref.get(MarketService);

    const quotes = await svc.quotes(["PETR4"]);
    expect(quotes[0]?.price).toBe("36.65");
    const [qUrl, qInit] = fetchMock.mock.calls[0] as [URL | string, RequestInit | undefined];
    expect(new URL(String(qUrl)).host).toBe("brapi.test.invalid");
    expect(String(qUrl)).not.toContain(TOKEN);
    expect(new Headers(qInit?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);

    fetchMock.mockClear();
    const macro = await svc.macro();
    expect(macro.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [url, init] of fetchMock.mock.calls as [URL | string, RequestInit | undefined][]) {
      expect(new URL(String(url)).host).toBe("bcb.test.invalid");
      expect(String(url)).not.toContain(TOKEN);
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
    }
  });

  it("live: MARKET_MAX_RESPONSE_BYTES do ENV limita o corpo (acima → provedor indisponível)", async () => {
    ref = await boot({
      MARKET_MODE: "live",
      BRAPI_TOKEN: TOKEN,
      BRAPI_BASE_URL: BRAPI_BASE,
      BCB_SGS_BASE_URL: BCB_BASE,
      MARKET_MAX_RESPONSE_BYTES: "50",
    });
    fetchMock.mockImplementation(() => Promise.resolve(new Response(QUOTE)));
    await expect(ref.get(MarketService).quotes(["PETR4"])).rejects.toBeInstanceOf(
      MarketDataUnavailableError,
    );
  });
});
