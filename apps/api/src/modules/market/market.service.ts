/**
 * Dados de mercado com cache no Redis e o preço de servidor da execução.
 *
 * Cache: chaves `market:<modo>:quote:<SYM>` (60 s), `market:<modo>:history:<SYM>:<range>` (600 s)
 * e `market:<modo>:macro` (3600 s). O modo (`MARKET_MODE`) entra no prefixo: um Redis
 * compartilhado entre mock e live (troca de modo, staging, api e worker em modos diferentes) nunca
 * serve a um o dado do outro. Além disso, cotação com `source` que não é a do modo (mock↔"mock",
 * live↔"brapi") é acerto perdido no cache e, vinda do provedor, não é gravada e é recusada pelo
 * `priceFor` (`price_unavailable`). O valor guardado é `{ value, fetchedAt }`, validado com Zod ao
 * ler; a expiração é conferida contra o `CLOCK` (a TTL do Redis é só limpeza). Os dados são
 * públicos, então a chave não leva o tenant. Erro do Redis, demora acima de `CACHE_OP_TIMEOUT_MS` ou valor ilegível
 * vira acerto perdido (log `warn`) e a busca segue no provedor: nada aqui depende do cache funcionar.
 *
 * Uma busca por vez por chave dentro do processo: a promessa em andamento é compartilhada e sai do
 * mapa ao terminar, inclusive em erro.
 *
 * `priceFor` falha fechado com `MarketPriceError`: ativo ausente → `unknown_asset`; provedor fora
 * do ar (qualquer erro), preço não positivo ou origem de outro modo → `price_unavailable`; cotação velha ou com hora
 * futura → `price_stale`. O frescor é medido sobre o `updatedAt` da cotação, nunca sobre o
 * `fetchedAt` do cache; cotação do cache reprovada no frescor é buscada de novo uma vez.
 */
import {
  type HistoricalBar,
  HistoricalBarSchema,
  type HistoryRange,
  HistoryRangeSchema,
  type MacroIndicator,
  MacroIndicatorSchema,
  type MarketState,
  PriceSchema,
  type Quote,
  QuoteSchema,
} from "@carina/shared";
import { Inject, Injectable, Logger, type OnModuleInit, Optional } from "@nestjs/common";
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
  "NODE_ENV" | "MARKET_MODE" | "MARKET_QUOTE_MAX_AGE_MS" | "MARKET_CLOSED_MAX_AGE_DAYS"
>;

export const MAX_SYMBOLS = 20;
export const QUOTE_TTL_MS = 60_000;
export const HISTORY_TTL_MS = 600_000;
export const MACRO_TTL_MS = 3_600_000;
/** Limite de cada operação no Redis: um Redis pendurado não segura a resposta. */
export const CACHE_OP_TIMEOUT_MS = 250;
const DAY_MS = 86_400_000;

const RawQuoteSchema = QuoteSchema.omit({ marketState: true });
const HistorySchema = z.array(HistoricalBarSchema);
const MacroSchema = z.array(MacroIndicatorSchema);

/** Cotação e sua origem: `priceFor` só busca de novo a que veio do cache. */
interface QuoteEntry {
  quote: RawQuote;
  fromCache: boolean;
}

/** Zero em qualquer grafia decimal ("0", "0.00", "000.0"): o formato já foi validado pelo schema. */
const ZERO_PRICE_RE = /^0+(\.0+)?$/;

const isPositivePrice = (price: string): boolean =>
  PriceSchema.safeParse(price).success && !ZERO_PRICE_RE.test(price);

/** Origem que as cotações de cada modo carregam. */
const SOURCE_OF_MODE: Readonly<Record<MarketEnv["MARKET_MODE"], RawQuote["source"]>> = {
  mock: "mock",
  live: "brapi",
};

@Injectable()
export class MarketService implements OnModuleInit {
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

  /**
   * `MARKET_MODE=mock` em produção é permitido (a demo do compose roda com NODE_ENV=production,
   * mesma política do `LLM_MODE`), mas fica registrado no boot; o aprovador vê `priceSource`.
   */
  onModuleInit(): void {
    if (this.env.NODE_ENV === "production" && this.env.MARKET_MODE === "mock") {
      this.logger.warn({ msg: "preços simulados (MARKET_MODE=mock)" });
    }
  }

  private get prefix(): string {
    return `market:${this.env.MARKET_MODE}:`;
  }

  private quoteKey(symbol: string): string {
    return `${this.prefix}quote:${symbol}`;
  }

  private historyKey(symbol: string, range: HistoryRange): string {
    return `${this.prefix}history:${symbol}:${range}`;
  }

  private get macroKey(): string {
    return `${this.prefix}macro`;
  }

  /** Preço utilizável: estritamente positivo e com a origem do modo configurado. */
  private isUsable(quote: RawQuote): boolean {
    return isPositivePrice(quote.price) && quote.source === SOURCE_OF_MODE[this.env.MARKET_MODE];
  }

  /** Preço de servidor tem de ser utilizável; caso contrário a ordem não sai. */
  private assertUsable(quote: RawQuote): void {
    if (!this.isUsable(quote)) throw new MarketPriceError("price_unavailable");
  }

  /** De 1 a 20 símbolos já normalizados (maiúsculos); repetidos viram um. Ausentes são omitidos. */
  async quotes(symbols: string[]): Promise<Quote[]> {
    const list = this.validSymbols(symbols);
    const raw = await this.rawQuotes(list);
    const state = this.marketState(this.clock());
    return raw.flatMap((e) => (e ? [{ ...e.quote, marketState: state }] : []));
  }

  async history(symbol: string, range: HistoryRange): Promise<HistoricalBar[]> {
    if (typeof symbol !== "string" || !SYMBOL_RE.test(symbol)) {
      throw new ValidationError("Símbolo inválido");
    }
    if (!HistoryRangeSchema.safeParse(range).success) throw new ValidationError("Período inválido");
    const key = this.historyKey(symbol, range);
    return this.singleFlight(key, () =>
      this.cached(key, HISTORY_TTL_MS, HistorySchema, () =>
        this.market.fetchHistory(symbol, range),
      ),
    );
  }

  async macro(): Promise<MacroIndicator[]> {
    const key = this.macroKey;
    return this.singleFlight(key, () =>
      this.cached(key, MACRO_TTL_MS, MacroSchema, () => this.macroProvider.fetchMacro()),
    );
  }

  /**
   * Preço de servidor para a execução de uma ordem. Só lança `MarketPriceError`.
   *
   * Uma cotação servida do cache que falha o frescor é buscada de novo UMA vez, sem cache, por um
   * single-flight próprio (`market:<modo>:quote:<SYM>:refresh`); a nova é gravada no cache e passa pela
   * mesma regra. Ainda velha → `price_stale` (sem laço); provedor falhando no refresh →
   * `price_unavailable`; ativo sumido no refresh → `unknown_asset`. Preço que não é estritamente
   * positivo (conferido na string, nunca por `number`) ou com `source` de outro modo →
   * `price_unavailable`.
   */
  async priceFor(symbol: string): Promise<Quote> {
    if (typeof symbol !== "string" || !SYMBOL_RE.test(symbol)) {
      throw new MarketPriceError("unknown_asset");
    }
    let entry: QuoteEntry | null | undefined;
    try {
      [entry] = await this.rawQuotes([symbol]);
    } catch {
      // Sem `cause`: o erro do provedor não viaja para quem registra a recusa.
      throw new MarketPriceError("price_unavailable");
    }
    if (!entry) throw new MarketPriceError("unknown_asset");
    this.assertUsable(entry.quote);

    let quote = entry.quote;
    if (!this.isFresh(quote)) {
      if (!entry.fromCache) throw new MarketPriceError("price_stale");
      let refreshed: RawQuote | null;
      try {
        refreshed = await this.refreshQuote(symbol);
      } catch {
        throw new MarketPriceError("price_unavailable");
      }
      if (!refreshed) throw new MarketPriceError("unknown_asset");
      this.assertUsable(refreshed);
      if (!this.isFresh(refreshed)) throw new MarketPriceError("price_stale");
      quote = refreshed;
    }
    return { ...quote, marketState: this.marketState(this.clock()) };
  }

  /** Idade = clock − updatedAt dentro do limite do estado do mercado; negativa/ilegível não vale. */
  private isFresh(quote: RawQuote): boolean {
    const now = this.clock();
    const age = now - Date.parse(quote.updatedAt);
    const maxAge =
      this.marketState(now) === "open"
        ? this.env.MARKET_QUOTE_MAX_AGE_MS
        : this.env.MARKET_CLOSED_MAX_AGE_DAYS * DAY_MS;
    return Number.isFinite(age) && age >= 0 && age <= maxAge;
  }

  /** Busca o símbolo no provedor sem ler o cache; `priceFor` concorrentes dividem a mesma busca. */
  private refreshQuote(symbol: string): Promise<RawQuote | null> {
    return this.singleFlight(`${this.quoteKey(symbol)}:refresh`, async () => {
      const found = await this.fetchAndStore([symbol]);
      return found.get(symbol) ?? null;
    });
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
   * símbolo esperem a mesma busca. Cada cotação diz se veio do cache ou da busca.
   */
  private rawQuotes(symbols: string[]): Promise<(QuoteEntry | null)[]> {
    const missing = symbols.filter((s) => !this.flights.has(this.quoteKey(s)));
    if (missing.length > 0) {
      const batch = this.loadQuotes(missing);
      for (const symbol of missing) {
        const key = this.quoteKey(symbol);
        const flight: Promise<QuoteEntry | null> = batch
          .then((found) => found.get(symbol) ?? null)
          .finally(() => {
            if (this.flights.get(key) === flight) this.flights.delete(key);
          });
        this.flights.set(key, flight);
      }
    }
    return Promise.all(
      symbols.map((s) => this.flights.get(this.quoteKey(s)) as Promise<QuoteEntry | null>),
    );
  }

  private async loadQuotes(symbols: string[]): Promise<Map<string, QuoteEntry>> {
    const found = new Map<string, QuoteEntry>();
    const hits = await Promise.all(
      symbols.map((s) => this.readCache(this.quoteKey(s), QUOTE_TTL_MS, RawQuoteSchema)),
    );
    const toFetch: string[] = [];
    symbols.forEach((symbol, i) => {
      const hit = hits[i];
      const expected = SOURCE_OF_MODE[this.env.MARKET_MODE];
      if (hit && hit.symbol === symbol && hit.source === expected) {
        found.set(symbol, { quote: hit, fromCache: true });
        return;
      }
      if (hit && hit.symbol !== symbol) {
        this.logger.warn({ msg: "Cache de cotação com outro símbolo; descartado", symbol });
      } else if (hit) {
        this.logger.warn({ msg: "Cache de cotação com origem de outro modo; descartado", symbol });
      }
      toFetch.push(symbol);
    });
    if (toFetch.length === 0) return found;

    for (const [symbol, quote] of await this.fetchAndStore(toFetch)) {
      found.set(symbol, { quote, fromCache: false });
    }
    return found;
  }

  /**
   * Busca no provedor (sem ler o cache), valida, grava no cache e devolve por símbolo. Só vai para
   * o cache a cotação utilizável (preço positivo e origem do modo): uma inválida não envenena a
   * entrada por 60 s; ela ainda volta a quem chamou, e o `priceFor` a recusa.
   */
  private async fetchAndStore(symbols: string[]): Promise<Map<string, RawQuote>> {
    const fetched = await this.market.fetchQuotes(symbols);
    const fetchedAt = this.clock();
    const wanted = new Set(symbols);
    const found = new Map<string, RawQuote>();
    for (const quote of fetched) {
      const parsed = RawQuoteSchema.safeParse(quote);
      if (!parsed.success) {
        this.logger.warn({ msg: "Cotação do provedor fora do contrato; descartada" });
        continue;
      }
      const q = parsed.data;
      if (!wanted.has(q.symbol) || found.has(q.symbol)) continue;
      found.set(q.symbol, q);
    }
    await Promise.all(
      [...found.values()]
        .filter((q) => this.isUsable(q))
        .map((q) => this.writeCache(this.quoteKey(q.symbol), q, fetchedAt, QUOTE_TTL_MS)),
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
