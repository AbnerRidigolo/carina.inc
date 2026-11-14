import { Module, type Provider } from "@nestjs/common";
import { ENV } from "../../core/config/config.module.js";
import type { Env } from "../../core/config/env.js";
import { RedisModule } from "../../core/redis/redis.module.js";
import { CLOCK, type Clock } from "../limits/clock.js";
import { LimitsCoreModule } from "../limits/limits-core.module.js";
import { MACRO_PROVIDER, MARKET_DATA_PROVIDER, MarketService } from "./market.service.js";
import { BcbProvider } from "./providers/bcb.provider.js";
import { BrapiProvider } from "./providers/brapi.provider.js";
import { MockMarketProvider } from "./providers/mock.provider.js";

/**
 * Provedor por `MARKET_MODE`: `mock` nunca constrói os provedores live (nem toca a rede); `live`
 * monta brapi + BCB a partir do ENV (token só no cabeçalho, dentro do provedor).
 */
const dataProvider: Provider = {
  provide: MARKET_DATA_PROVIDER,
  inject: [ENV, CLOCK],
  useFactory: (env: Env, clock: Clock) =>
    env.MARKET_MODE === "live"
      ? new BrapiProvider({
          baseUrl: env.BRAPI_BASE_URL,
          token: env.BRAPI_TOKEN,
          timeoutMs: env.MARKET_FETCH_TIMEOUT_MS,
          maxBytes: env.MARKET_MAX_RESPONSE_BYTES,
          fetchImpl: globalThis.fetch,
          now: clock,
        })
      : new MockMarketProvider(clock),
};

const macroProvider: Provider = {
  provide: MACRO_PROVIDER,
  inject: [ENV, CLOCK],
  useFactory: (env: Env, clock: Clock) =>
    env.MARKET_MODE === "live"
      ? new BcbProvider({
          baseUrl: env.BCB_SGS_BASE_URL,
          timeoutMs: env.MARKET_FETCH_TIMEOUT_MS,
          maxBytes: env.MARKET_MAX_RESPONSE_BYTES,
          fetchImpl: globalThis.fetch,
          now: clock,
        })
      : new MockMarketProvider(clock),
};

/** MarketService e provedores, sem rotas nem guards (orquestrador e WorkerModule). */
@Module({
  imports: [RedisModule, LimitsCoreModule],
  providers: [dataProvider, macroProvider, MarketService],
  exports: [MarketService],
})
export class MarketCoreModule {}
