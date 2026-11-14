/**
 * Dados de mercado com cache no Redis e o preço de servidor da execução.
 *
 * Cache: chaves `market:quote:<SYM>` (60 s), `market:history:<SYM>:<range>` (600 s) e
 * `market:macro` (3600 s). O valor guardado é `{ value, fetchedAt }`, validado com Zod ao ler; a
 * expiração é conferida contra o `CLOCK` (a TTL do Redis é só limpeza). Os dados são públicos, então
 * a chave não leva o tenant. Erro do Redis, demora acima de `CACHE_OP_TIMEOUT_MS` ou valor ilegível
 * vira acerto perdido (log `warn`) e a busca segue no provedor: nada aqui depende do cache funcionar.
 *
 * Uma busca por vez por chave dentro do processo: a promessa em andamento é compartilhada e sai do
 * mapa ao terminar, inclusive em erro.
 *
 * `priceFor` falha fechado com `MarketPriceError`: ativo ausente → `unknown_asset`; provedor fora
 * do ar (qualquer erro) → `price_unavailable`; cotação velha ou com hora futura → `price_stale`. O
 * frescor é medido sobre o `updatedAt` da cotação, nunca sobre o `fetchedAt` do cache.
 */
import {
  type HistoricalBar,
  HistoricalBarSchema,
  type HistoryRange,
  HistoryRangeSchema,
  type MacroIndicator,
  MacroIndicatorSchema,
  type MarketState,
  type Quote,
  QuoteSchema,
} from "@carina/shared";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { Redis } from "ioredis";
import { type ZodType, z } from "zod";
import { ENV } from "../../core/config/config.module.js";
import type { Env } from "../../core/config/env.js";
import { ValidationError } from "../../core/errors/domain-errors.js";
import { REDIS } from "../../core/redis/redis.tokens.js";
import { CLOCK, type Clock } from "../limits/clock.js";
import { SYMBOL_RE } from "./asset-class.js";
import { MarketPriceError } from "./market-price-error.js";
import { marketStateAt } from "./market-hours.js";
import type { MacroProvider, MarketDataProvider, RawQuote } from "./providers/types.js";

export const MARKET_DATA_PROVIDER = Symbol("MARKET_DATA_PROVIDER");
export const MACRO_PROVIDER = Symbol("MACRO_PROVIDER");
export const MARKET_LOGGER = Symbol("MARKET_LOGGER");

/** Forma de OBJETO no 1º argumento (nestjs-pino): `err` no topo; só ids. */
export interface MarketLogger {
  warn(fields: { msg: string; err?: unknown; [k: string]: unknown }): void;
}

export type MarketEnv = Pick<
  Env,
  "MARKET_MODE" | "MARKET_QUOTE_MAX_AGE_MS" | "MARKET_CLOSED_MAX_AGE_DAYS"
>;

export const MAX_SYMBOLS = 20;
export const QUOTE_TTL_MS = 60_000;
export const HISTORY_TTL_MS = 600_000;
export const MACRO_TTL_MS = 3_600_000;
/** Limite de cada operação no Redis: um Redis pendurado não segura a resposta. */
export const CACHE_OP_TIMEOUT_MS = 250;
const DAY_MS = 86_400_000;
const PREFIX = "market:";

const RawQuoteSchema = QuoteSchema.omit({ marketState: true });
const HistorySchema = z.array(HistoricalBarSchema);
const MacroSchema = z.array(MacroIndicatorSchema);

const quoteKey = (symbol: string) => `${PREFIX}quote:${symbol}`;
const historyKey = (symbol: string, range: HistoryRange) => `${PREFIX}history:${symbol}:${range}`;
const MACRO_KEY = `${PREFIX}macro`;

@Injectable()
export class MarketService {
  private readonly flights = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(MARKET_DATA_PROVIDER) private readonly market: MarketDataProvider,
    @Inject(MACRO_PROVIDER) private readonly macroProvider: MacroProvider,
    @Inject(REDIS) private readonly redis: Pick<Redis, "get" | "set">,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: MarketEnv,
    @Optional()
    @Inject(MARKET_LOGGER)
    private readonly logger: MarketLogger = new Logger(MarketService.name),
  ) {}

  /** De 1 a 20 símbolos já normalizados (maiúsculos); repetidos viram um. Ausentes são omitidos. */
  async quotes(symbols: string[]): Promise<Quote[]> {
    const list = this.validSymbols(symbols);
    const raw = await this.rawQuotes(list);
    const state = this.marketState(this.clock());
    return raw.flatMap((q) => (q ? [{ ...q, marketState: state }] : []));
  }

  async history(symbol: string, range: HistoryRange): Promise<HistoricalBar[]> {
    if (typeof symbol !== "string" || !SYMBOL_RE.test(symbol)) {
      throw new ValidationError("Símbolo inválido");
    }
    if (!HistoryRangeSchema.safeParse(range).success) throw new ValidationError("Período inválido");
    const key = historyKey(symbol, range);
    return this.singleFlight(key, () =>
      this.cached(key, HISTORY_TTL_MS, HistorySchema, () =>
        this.market.fetchHistory(symbol, range),
      ),
    );
  }

  async macro(): Promise<MacroIndicator[]> {
    return this.singleFlight(MACRO_KEY, () =>
      this.cached(MACRO_KEY, MACRO_TTL_MS, MacroSchema, () => this.macroProvider.fetchMacro()),
    );
  }

  /** Preço de servidor para a execução de uma ordem. Só lança `MarketPriceError`. */
  async priceFor(symbol: string): Promise<Quote> {
    if (typeof symbol !== "string" || !SYMBOL_RE.test(symbol)) {
      throw new MarketPriceError("unknown_asset");
    }
    let raw: RawQuote | null | undefined;
    try {
      [raw] = await this.rawQuotes([symbol]);
    } catch {
      // Sem `cause`: o erro do provedor não viaja para quem registra a recusa.
      throw new MarketPriceError("price_unavailable");
    }
    if (!raw) throw new MarketPriceError("unknown_asset");

    const now = this.clock();
    const state = this.marketState(now);
    const age = now - Date.parse(raw.updatedAt);
    const maxAge =
      state === "open"
        ? this.env.MARKET_QUOTE_MAX_AGE_MS
        : this.env.MARKET_CLOSED_MAX_AGE_DAYS * DAY_MS;
    // Idade negativa (hora no futuro) ou ilegível também é recusada.
    if (!Number.isFinite(age) || age < 0 || age > maxAge) {
      throw new MarketPriceError("price_stale");
    }
    return { ...raw, marketState: state };
  }

  private marketState(now: number): MarketState {
    return this.env.MARKET_MODE === "mock" ? "open" : marketStateAt(now);
  }

  private validSymbols(symbols: string[]): string[] {
    if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length > MAX_SYMBOLS) {
      throw new ValidationError(`Informe de 1 a ${String(MAX_SYMBOLS)} símbolos`);
    }
    for (const s of symbols) {
      if (typeof s !== "string" || !SYMBOL_RE.test(s))
        throw new ValidationError("Símbolo inválido");
    }
    return [...new Set(symbols)];
  }

  /**
   * Cotações por símbolo (null = ausente do provedor). Os símbolos sem busca em andamento entram
   * numa busca só; cada um ganha a sua promessa no mapa, para que chamadas concorrentes do mesmo
   * símbolo esperem a mesma busca.
   */
  private rawQuotes(symbols: string[]): Promise<(RawQuote | null)[]> {
    const missing = symbols.filter((s) => !this.flights.has(quoteKey(s)));
    if (missing.length > 0) {
      const batch = this.loadQuotes(missing);
      for (const symbol of missing) {
        const key = quoteKey(symbol);
        const flight: Promise<RawQuote | null> = batch
          .then((found) => found.get(symbol) ?? null)
          .finally(() => {
            if (this.flights.get(key) === flight) this.flights.delete(key);
          });
        this.flights.set(key, flight);
      }
    }
    return Promise.all(
      symbols.map((s) => this.flights.get(quoteKey(s)) as Promise<RawQuote | null>),
    );
  }

  private async loadQuotes(symbols: string[]): Promise<Map<string, RawQuote>> {
    const found = new Map<string, RawQuote>();
    const hits = await Promise.all(
      symbols.map((s) => this.readCache(quoteKey(s), QUOTE_TTL_MS, RawQuoteSchema)),
    );
    const toFetch: string[] = [];
    symbols.forEach((symbol, i) => {
      const hit = hits[i];
      if (hit && hit.symbol === symbol) {
        found.set(symbol, hit);
        return;
      }
      if (hit) this.logger.warn({ msg: "Cache de cotação com outro símbolo; descartado", symbol });
      toFetch.push(symbol);
    });
    if (toFetch.length === 0) return found;

    const fetched = await this.market.fetchQuotes(toFetch);
    const fetchedAt = this.clock();
    const wanted = new Set(toFetch);
    const fresh: RawQuote[] = [];
    for (const quote of fetched) {
      const parsed = RawQuoteSchema.safeParse(quote);
      if (!parsed.success) {
        this.logger.warn({ msg: "Cotação do provedor fora do contrato; descartada" });
        continue;
      }
      const q = parsed.data;
      if (!wanted.has(q.symbol) || found.has(q.symbol)) continue;
      found.set(q.symbol, q);
      fresh.push(q);
    }
    await Promise.all(
      fresh.map((q) => this.writeCache(quoteKey(q.symbol), q, fetchedAt, QUOTE_TTL_MS)),
    );
    return found;
  }

  private singleFlight<T>(key: string, load: () => Promise<T>): Promise<T> {
    const running = this.flights.get(key);
    if (running) return running as Promise<T>;
    const flight: Promise<T> = load().finally(() => {
      if (this.flights.get(key) === flight) this.flights.delete(key);
    });
    this.flights.set(key, flight);
    return flight;
  }

  private async cached<T>(
    key: string,
    ttlMs: number,
    schema: ZodType<T>,
    load: () => Promise<T>,
  ): Promise<T> {
    const hit = await this.readCache(key, ttlMs, schema);
    if (hit !== undefined) return hit;
    const fetchedAt = this.clock();
    const value = await load();
    await this.writeCache(key, value, fetchedAt, ttlMs);
    return value;
  }

  /** Valor ainda válido pelo CLOCK, ou `undefined` (ausente, expirado, ilegível ou Redis com erro). */
  private async readCache<T>(
    key: string,
    ttlMs: number,
    schema: ZodType<T>,
  ): Promise<T | undefined> {
    let raw: string | null;
    try {
      raw = await this.cacheOp(() => this.redis.get(key));
    } catch (err) {
      this.logger.warn({
        msg: "Leitura do cache de mercado falhou; seguindo no provedor",
        err,
        key,
      });
      return undefined;
    }
    if (raw === null) return undefined;

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const parsed = z
      .object({ value: schema, fetchedAt: z.number().int().nonnegative() })
      .safeParse(json);
    if (!parsed.success) {
      // Sem o erro do Zod: ele repetiria o conteúdo guardado.
      this.logger.warn({ msg: "Valor ilegível no cache de mercado; descartado", key });
      return undefined;
    }
    const age = this.clock() - parsed.data.fetchedAt;
    if (age < 0 || age >= ttlMs) return undefined;
    return parsed.data.value;
  }

  private async writeCache(key: string, value: unknown, fetchedAt: number, ttlMs: number) {
    try {
      await this.cacheOp(() =>
        this.redis.set(key, JSON.stringify({ value, fetchedAt }), "PX", ttlMs),
      );
    } catch (err) {
      this.logger.warn({ msg: "Gravação no cache de mercado falhou", err, key });
    }
  }

  /** Roda a operação no Redis com limite de tempo; erro síncrono vira rejeição. */
  private async cacheOp<T>(op: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Tempo esgotado no cache de mercado"));
      }, CACHE_OP_TIMEOUT_MS);
    });
    try {
      return await Promise.race([Promise.resolve().then(op), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
