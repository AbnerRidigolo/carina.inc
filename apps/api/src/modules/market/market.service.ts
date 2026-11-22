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
 * mapa ao terminar, inclusive em erro. As buscas das rotas e as do `priceFor` não se juntam (cada
 * uma paga o seu orçamento, abaixo).
 *
 * Cache negativo: símbolo pedido que não volta do provedor é gravado como ausente
 * (`{ absent: true, symbol }`, mesmo envelope validado) por 60 s; as rotas o omitem e o `priceFor`
 * responde `unknown_asset`, sem ir ao provedor. Símbolos desconhecidos ou rotativos não queimam a
 * cota do token a cada requisição.
 *
 * Orçamento de chamadas ao provedor (janela FIXA de 1 minuto pelo `CLOCK`, contador no Redis com
 * INCRBY + PEXPIRE atômicos num EVAL; uma unidade por requisição ao provedor, ou seja, por lote de
 * `MARKET_BRAPI_MAX_SYMBOLS_PER_CALL` símbolos). Só conta o que vai ao provedor (acerto de cache
 * não consome). Três orçamentos, por modo:
 * - rotas (`quotes`/`history`): `market:<modo>:budget:<minuto>`, `MARKET_PROVIDER_MAX_CALLS_PER_MIN`.
 *   Esgotado → `MarketDataBusyError` (503 problem+json, mensagem fixa, `Retry-After` = segundos até
 *   a próxima janela), sem chamar o provedor e sem cobrança (o controller só cobra depois do
 *   sucesso). Redis fora do ar → falha FECHADA (`MarketDataUnavailableError`, 502): sem Redis também
 *   não há cache, então cada rota iria ao provedor — exatamente a queima de cota que o orçamento
 *   evita; e o limite por tenant (RateLimitGuard) já depende do mesmo Redis.
 * - preço (`priceFor`, inclusive o refresh): `market:<modo>:budget:price:<minuto>`,
 *   `MARKET_PRICE_MAX_CALLS_PER_MIN`, separado para um tenant nas rotas não esgotar o preço das ordens
 *   dos outros. Esgotado → `price_unavailable` (falha fechada da ordem). Redis fora do ar → falha
 *   ABERTA (log `warn`): o preço não pode depender do Redis (nada no `priceFor` depende) e ele só
 *   roda em propostas de ordem, já limitadas por tenant no chat e por busca única por símbolo.
 * - monitor (`monitorQuotes`, o job de alertas da carteira): `market:<modo>:budget:monitor:<minuto>`,
 *   `MARKET_MONITOR_MAX_CALLS_PER_MIN`, separado das rotas e do preço para o monitor nunca
 *   esgotá-los. Uma unidade por lote, cobrada ANTES de cada lote; esgotado → para de buscar e devolve
 *   o que já tem (cache + lotes já buscados) com `exhausted: true`, sem lançar `MarketDataBusyError`,
 *   e `pending` = os símbolos pedidos que NÃO foram tentados (nem cache nem provedor), na ordem
 *   pedida; ausente do provedor (ou do cache negativo) conta como tentado. O rodízio do job avança
 *   o cursor só até antes do primeiro pendente e retoma dali no próximo ciclo. Lote em que o
 *   provedor falha (`MarketDataUnavailableError`: 401/403/5xx, formato inválido, rede) também conta
 *   como tentado: é omitido, os lotes já buscados ficam e os seguintes seguem (log `warn` só com a
 *   contagem e o nome do erro); um símbolo ruim não trava o monitor. Redis fora do ar → LANÇA
 *   (`MarketDataUnavailableError`, falha fechada): o job pula o ciclo, como já faz sem o lock.
 *   Sem busca única por símbolo: o job roda sob lock global, um ciclo por vez.
 * `macro` não consome: uma chave só, cache de 1 h (no máximo uma busca por hora por processo).
 *
 * `priceFor` falha fechado com `MarketPriceError`: ativo ausente → `unknown_asset`; provedor fora
 * do ar (qualquer erro), orçamento do preço esgotado, preço não positivo ou origem de outro modo →
 * `price_unavailable`; cotação velha ou com hora
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
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { type ZodType, z } from "zod";
import { ENV } from "../../core/config/config.module.js";
import type { Env } from "../../core/config/env.js";
import {
  MarketDataBusyError,
  MarketDataUnavailableError,
  ValidationError,
} from "../../core/errors/domain-errors.js";
import { REDIS } from "../../core/redis/redis.tokens.js";
import { CLOCK, type Clock } from "../limits/clock.js";
import { SYMBOL_RE } from "./asset-class.js";
import { MarketPriceError } from "./market-price-error.js";
import { marketStateAt, quoteAgeWithin } from "./market-hours.js";
import type { MacroProvider, MarketDataProvider, RawQuote } from "./providers/types.js";

export const MARKET_DATA_PROVIDER = Symbol("MARKET_DATA_PROVIDER");
export const MACRO_PROVIDER = Symbol("MACRO_PROVIDER");
/** Logger do serviço, provido por `marketLoggerProvider` (substituível com `overrideProvider`). */
export const MARKET_LOGGER = Symbol("MARKET_LOGGER");

/** Forma de OBJETO no 1º argumento (nestjs-pino): `err` no topo; só ids. */
export interface MarketLogger {
  warn(fields: { msg: string; err?: unknown; [k: string]: unknown }): void;
}

export type MarketEnv = Pick<
  Env,
  | "NODE_ENV"
  | "MARKET_MODE"
  | "MARKET_QUOTE_MAX_AGE_MS"
  | "MARKET_CLOSED_MAX_AGE_DAYS"
  | "MARKET_BRAPI_MAX_SYMBOLS_PER_CALL"
  | "MARKET_PROVIDER_MAX_CALLS_PER_MIN"
  | "MARKET_PRICE_MAX_CALLS_PER_MIN"
  | "MARKET_MONITOR_MAX_CALLS_PER_MIN"
>;

export const MAX_SYMBOLS = 20;
export const QUOTE_TTL_MS = 60_000;
export const HISTORY_TTL_MS = 600_000;
export const MACRO_TTL_MS = 3_600_000;
/** Limite de cada operação no Redis: um Redis pendurado não segura a resposta. */
export const CACHE_OP_TIMEOUT_MS = 250;
const DAY_MS = 86_400_000;
/** Janela fixa do orçamento de chamadas ao provedor. */
export const BUDGET_WINDOW_MS = 60_000;

/**
 * Soma `ARGV[1]` unidades ao contador da janela e (re)define a expiração (`ARGV[2]` ms), num só
 * EVAL (atômico); devolve o total da janela já com estas unidades.
 */
export const BUDGET_LUA = `
local used = redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return used
`;

/** Quem paga a busca no provedor: as rotas, o preço das ordens ou o monitor de carteira. */
type Payer = "routes" | "price" | "monitor";

const RawQuoteSchema = QuoteSchema.omit({ marketState: true });
/** Marcador do cache negativo: o provedor não devolveu este símbolo. */
const AbsentSchema = z.object({ absent: z.literal(true), symbol: z.string() }).strict();
const QuoteCacheSchema = z.union([RawQuoteSchema, AbsentSchema]);
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
    @Inject(REDIS) private readonly redis: Pick<Redis, "get" | "set" | "eval">,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: MarketEnv,
    @Inject(MARKET_LOGGER) private readonly logger: MarketLogger,
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
    const raw = await this.rawQuotes(list, "routes");
    const state = this.marketState(this.clock());
    return raw.flatMap((e) => (e ? [{ ...e.quote, marketState: state }] : []));
  }

  /**
   * Cotações para o monitor de carteira, no orçamento próprio (ver o cabeçalho). Repetidos viram
   * um; ausentes do provedor são omitidos. Orçamento esgotado → devolve o que já tem com
   * `exhausted: true` e os não tentados em `pending` (na ordem pedida); Redis fora → lança.
   * Provedor falhando num lote (`MarketDataUnavailableError`) → o lote conta como tentado (omitido,
   * fora do `pending`) e os demais lotes seguem.
   */
  async monitorQuotes(
    symbols: string[],
  ): Promise<{ quotes: Quote[]; exhausted: boolean; pending: string[] }> {
    if (!Array.isArray(symbols)) throw new ValidationError("Símbolos inválidos");
    for (const s of symbols) {
      if (typeof s !== "string" || !SYMBOL_RE.test(s))
        throw new ValidationError("Símbolo inválido");
    }
    const list = [...new Set(symbols)];
    const { found, toFetch } = await this.readQuoteCache(list);
    let exhausted = false;
    let untried: ReadonlySet<string> = new Set();
    let failed = 0;
    let errName = "";
    const perCall = this.env.MARKET_BRAPI_MAX_SYMBOLS_PER_CALL;
    for (let i = 0; i < toFetch.length; i += perCall) {
      try {
        await this.consumeBudget("monitor", 1);
      } catch (err) {
        if (!(err instanceof MarketDataBusyError)) throw err;
        exhausted = true;
        untried = new Set(toFetch.slice(i));
        break;
      }
      const chunk = toFetch.slice(i, i + perCall);
      let fetched: Map<string, RawQuote>;
      try {
        fetched = await this.fetchAndStore(chunk);
      } catch (err) {
        // Provedor fora do ar ou recusando este lote: o lote conta como tentado (fora do
        // `pending`, o rodízio passa por ele), o que já veio fica e os próximos lotes seguem.
        if (!(err instanceof MarketDataUnavailableError)) throw err;
        failed += chunk.length;
        errName = err.name;
        continue;
      }
      for (const [symbol, quote] of fetched) {
        found.set(symbol, { quote, fromCache: false });
      }
    }
    if (failed > 0) {
      // Só contagem e nome do erro: nenhum código de ativo.
      this.logger.warn({ msg: "Lote do monitor falhou no provedor; seguindo", failed, errName });
    }
    const state = this.marketState(this.clock());
    const quotes = list.flatMap((s) => {
      const e = found.get(s);
      return e ? [{ ...e.quote, marketState: state }] : [];
    });
    return { quotes, exhausted, pending: list.filter((s) => untried.has(s)) };
  }

  async history(symbol: string, range: HistoryRange): Promise<HistoricalBar[]> {
    if (typeof symbol !== "string" || !SYMBOL_RE.test(symbol)) {
      throw new ValidationError("Símbolo inválido");
    }
    if (!HistoryRangeSchema.safeParse(range).success) throw new ValidationError("Período inválido");
    const key = this.historyKey(symbol, range);
    return this.singleFlight(key, () =>
      this.cached(key, HISTORY_TTL_MS, HistorySchema, async () => {
        await this.consumeBudget("routes", 1);
        return this.market.fetchHistory(symbol, range);
      }),
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
      [entry] = await this.rawQuotes([symbol], "price");
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
    const maxAge =
      this.marketState(now) === "open"
        ? this.env.MARKET_QUOTE_MAX_AGE_MS
        : this.env.MARKET_CLOSED_MAX_AGE_DAYS * DAY_MS;
    return quoteAgeWithin(quote.updatedAt, now, maxAge);
  }

  /** Busca o símbolo no provedor sem ler o cache; `priceFor` concorrentes dividem a mesma busca. */
  private refreshQuote(symbol: string): Promise<RawQuote | null> {
    return this.singleFlight(`${this.quoteKey(symbol)}:refresh`, async () => {
      await this.consumeBudget("price", 1);
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
  private rawQuotes(symbols: string[], payer: Payer): Promise<(QuoteEntry | null)[]> {
    const flightKey = (s: string) => `${payer}:${this.quoteKey(s)}`;
    const missing = symbols.filter((s) => !this.flights.has(flightKey(s)));
    if (missing.length > 0) {
      const batch = this.loadQuotes(missing, payer);
      for (const symbol of missing) {
        const key = flightKey(symbol);
        const flight: Promise<QuoteEntry | null> = batch
          .then((found) => found.get(symbol) ?? null)
          .finally(() => {
            if (this.flights.get(key) === flight) this.flights.delete(key);
          });
        this.flights.set(key, flight);
      }
    }
    return Promise.all(
      symbols.map((s) => this.flights.get(flightKey(s)) as Promise<QuoteEntry | null>),
    );
  }

  private async loadQuotes(symbols: string[], payer: Payer): Promise<Map<string, QuoteEntry>> {
    const { found, toFetch } = await this.readQuoteCache(symbols);
    if (toFetch.length === 0) return found;

    await this.consumeBudget(
      payer,
      Math.ceil(toFetch.length / this.env.MARKET_BRAPI_MAX_SYMBOLS_PER_CALL),
    );
    for (const [symbol, quote] of await this.fetchAndStore(toFetch)) {
      found.set(symbol, { quote, fromCache: false });
    }
    return found;
  }

  /** Lê o cache de cotações: o que serve (`found`) e o que precisa ir ao provedor (`toFetch`). */
  private async readQuoteCache(
    symbols: string[],
  ): Promise<{ found: Map<string, QuoteEntry>; toFetch: string[] }> {
    const found = new Map<string, QuoteEntry>();
    const hits = await Promise.all(
      symbols.map((s) => this.readCache(this.quoteKey(s), QUOTE_TTL_MS, QuoteCacheSchema)),
    );
    const toFetch: string[] = [];
    symbols.forEach((symbol, i) => {
      const hit = hits[i];
      const expected = SOURCE_OF_MODE[this.env.MARKET_MODE];
      // Ausente em cache (cache negativo): fica fora do mapa e não vai ao provedor.
      if (hit && "absent" in hit && hit.symbol === symbol) return;
      if (hit && "absent" in hit) {
        this.logger.warn({ msg: "Cache de cotação com outro símbolo; descartado", symbol });
        toFetch.push(symbol);
        return;
      }
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
    return { found, toFetch };
  }

  /**
   * Busca no provedor (sem ler o cache), valida, grava no cache e devolve por símbolo. Só vai para
   * o cache a cotação utilizável (preço positivo e origem do modo): uma inválida não envenena a
   * entrada por 60 s; ela ainda volta a quem chamou, e o `priceFor` a recusa. Símbolo pedido que
   * não voltou vai para o cache negativo (60 s).
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
    const absent = symbols.filter((s) => !found.has(s));
    await Promise.all([
      ...[...found.values()]
        .filter((q) => this.isUsable(q))
        .map((q) => this.writeCache(this.quoteKey(q.symbol), q, fetchedAt, QUOTE_TTL_MS)),
      ...absent.map((symbol) =>
        this.writeCache(this.quoteKey(symbol), { absent: true, symbol }, fetchedAt, QUOTE_TTL_MS),
      ),
    ]);
    return found;
  }

  /**
   * Consome `units` do orçamento de `payer` na janela atual (ver o cabeçalho do módulo para o
   * comportamento quando esgota e quando o Redis falha).
   */
  private async consumeBudget(payer: Payer, units: number): Promise<void> {
    const now = this.clock();
    const window = Math.floor(now / BUDGET_WINDOW_MS);
    const key =
      payer === "routes"
        ? `${this.prefix}budget:${String(window)}`
        : `${this.prefix}budget:${payer}:${String(window)}`;
    const limit = {
      routes: this.env.MARKET_PROVIDER_MAX_CALLS_PER_MIN,
      price: this.env.MARKET_PRICE_MAX_CALLS_PER_MIN,
      monitor: this.env.MARKET_MONITOR_MAX_CALLS_PER_MIN,
    }[payer];
    let used: number;
    try {
      const reply = await this.cacheOp(() =>
        this.redis.eval(BUDGET_LUA, 1, key, String(units), String(2 * BUDGET_WINDOW_MS)),
      );
      used = typeof reply === "number" ? reply : Number.NaN;
      if (!Number.isInteger(used)) throw new Error("Resposta inesperada do Redis no orçamento");
    } catch (err) {
      if (payer === "price") {
        this.logger.warn({ msg: "Orçamento do preço sem Redis; seguindo (falha aberta)", err });
        return;
      }
      const who = payer === "monitor" ? "do monitor" : "das rotas";
      this.logger.warn({ msg: `Orçamento ${who} sem Redis; recusando (falha fechada)`, err });
      throw new MarketDataUnavailableError();
    }
    if (used > limit) {
      const retryAfterMs = (window + 1) * BUDGET_WINDOW_MS - now;
      throw new MarketDataBusyError(Math.max(1, Math.ceil(retryAfterMs / 1000)));
    }
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
    // Validado ANTES de gravar: dado fora do contrato não entra no cache nem volta a quem chamou.
    const parsed = schema.safeParse(await load());
    if (!parsed.success) {
      this.logger.warn({ msg: "Dado do provedor fora do contrato; descartado", key });
      throw new MarketDataUnavailableError();
    }
    await this.writeCache(key, parsed.data, fetchedAt, ttlMs);
    return parsed.data;
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

/** Provider do logger do serviço (o mesmo padrão de `ingestionLoggerProvider`). */
export const marketLoggerProvider = {
  provide: MARKET_LOGGER,
  useFactory: (): MarketLogger => new Logger(MarketService.name),
};
