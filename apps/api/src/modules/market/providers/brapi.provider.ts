/**
 * Provedor live de cotações e histórico: brapi.dev, rota v1 `GET /api/quote/{tickers}`.
 *
 * Fonte do formato (consultada em 2026-11-14 por busca na web, porque o sandbox não resolve
 * brapi.dev): especificação OpenAPI oficial (brapi.dev/swagger/latest.json e
 * api.brapi.dev/openapi.json, schemas `QuoteTickersResponse`, `QuoteResult` e
 * `HistoricalDataPrice`) e brapi.dev/docs/authentication.
 * - Autenticação: `Authorization: Bearer <chave>` (a doc desaconselha `?token=`; aqui nunca se usa).
 * - `results[]`: `symbol`, `shortName`/`longName` (nullable), `currency`, `regularMarketPrice`,
 *   `regularMarketChangePercent`, `regularMarketPreviousClose`, `regularMarketVolume` (number,
 *   nullable) e `regularMarketTime` (ISO 8601, nullable).
 * - Com `range` e `interval`: `historicalDataPrice[]` com `date` (Unix em segundos) e
 *   `open`/`high`/`low`/`close`/`volume` (number, nullable).
 * - Ticker inexistente fica fora de `results`; se nenhum ticker pedido existe a resposta é 404 com
 *   corpo de erro `{ error: true, message }`. Só esse 404 vira resultado vazio (o símbolo ausente
 *   significa "ativo desconhecido" tanto na perda parcial quanto na total); qualquer outro 404
 *   (corpo diferente, caminho base errado) e qualquer outro status fora de 2xx viram
 *   `MarketDataUnavailableError`.
 * - `regularMarketTime` só vale como ISO 8601 estrito com `Z` ou offset, entre 2000-01-01 e
 *   `now + 2 min` (tolerância de relógio): hora futura daria idade negativa e passaria no frescor.
 * NÃO verificado contra uma resposta real (sem rede): as fixtures são reconstruídas do exemplo da
 * especificação. O mapeamento de campos segue o `BrapiProvider` do legado Python.
 */
import {
  HistoricalBarSchema,
  HistoryRangeSchema,
  PriceSchema,
  QuoteSchema,
  type HistoricalBar,
  type HistoryRange,
} from "@carina/shared";
import { z } from "zod";
import { MarketDataUnavailableError, ValidationError } from "../../../core/errors/domain-errors.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { Clock } from "../../limits/clock.js";
import { inferAssetClass, SYMBOL_RE } from "../asset-class.js";
import {
  buildProviderUrl,
  defaultMarketLogger,
  safeFetchJsonResponse,
  withNetworkRetry,
  type MarketLogger,
} from "./safe-fetch.js";
import type { MarketDataProvider, RawQuote } from "./types.js";

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

/** Teto de símbolos por chamada (a rota repete a regra com 422). */
export const MAX_SYMBOLS_PER_CALL = 20;
/** 5 anos de pregões são ~1.260 barras; acima disso a resposta é recusada. */
const MAX_BARS = 2000;
const MAX_NAME_LENGTH = 120;
const MAX_DECIMAL_PLACES = 6;
/** Faixa aceita para `date` (segundos): 2000-01-01 a 2100-01-01. */
const MIN_BAR_EPOCH_S = 946_684_800;
const MAX_BAR_EPOCH_S = 4_102_444_800;
/** Tolerância para relógio adiantado do provedor: hora além de `now + 2 min` é descartada. */
export const CLOCK_SKEW_MS = 2 * 60_000;
/** Piso da hora da cotação (2000-01-01T00:00:00Z). */
const MIN_QUOTE_TIME_MS = Date.UTC(2000, 0, 1);

/** ISO 8601 estrito, com `Z` ou offset (sem hora "local" ambígua nem formatos que o `Date.parse` aceita). */
const QuoteTimeSchema = z.iso.datetime({ offset: true });

/** Corpo do 404 da brapi quando nenhum ticker pedido existe. */
const BrapiNotFoundSchema = z.object({ error: z.literal(true), message: z.string() });

const RawQuoteSchema = QuoteSchema.omit({ marketState: true });

const QuoteResponseSchema = z.object({
  results: z.array(z.unknown()).max(MAX_SYMBOLS_PER_CALL * 2),
});

const QuoteItemSchema = z.object({
  symbol: z.string().max(16),
  shortName: z.unknown().optional(),
  longName: z.unknown().optional(),
  currency: z.unknown().optional(),
  regularMarketPrice: z.unknown().optional(),
  regularMarketChangePercent: z.unknown().optional(),
  regularMarketPreviousClose: z.unknown().optional(),
  regularMarketVolume: z.unknown().optional(),
  regularMarketTime: z.unknown().optional(),
});

const HistoryItemSchema = z.object({
  symbol: z.string().max(16),
  historicalDataPrice: z.array(z.unknown()).max(MAX_BARS).optional(),
});

const BarSchema = z.object({
  date: z.number().int().min(MIN_BAR_EPOCH_S).max(MAX_BAR_EPOCH_S),
  open: z.unknown(),
  high: z.unknown(),
  low: z.unknown(),
  close: z.unknown(),
  volume: z.unknown(),
});

const SAO_PAULO_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** JSON `number` finito -> `Decimal` pela representação textual, com até 6 casas e sem `-0`. */
function toDecimal(raw: unknown): Decimal | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const d = new Decimal(String(raw)).toDecimalPlaces(MAX_DECIMAL_PLACES, Decimal.ROUND_HALF_UP);
  return d.isZero() ? new Decimal(0) : d;
}

/** Preço estritamente positivo e dentro de `PriceSchema`; senão `null`. */
function toPrice(raw: unknown): string | null {
  const d = toDecimal(raw);
  if (d === null || d.lte(0)) return null;
  const text = d.toFixed();
  return PriceSchema.safeParse(text).success ? text : null;
}

function toChangePct(raw: unknown): string | null {
  const d = toDecimal(raw);
  if (d === null) return null;
  const text = d.toFixed();
  return QuoteSchema.shape.changePct.safeParse(text).success ? text : null;
}

/** Volume inteiro não negativo dentro do limite do contrato; senão `null`. */
function toVolume(raw: unknown): string | null {
  const d = toDecimal(raw);
  if (d === null || d.isNegative() || !d.isInteger()) return null;
  const text = d.toFixed(0);
  return QuoteSchema.shape.volume.safeParse(text).success ? text : null;
}

/** Hora da cotação em UTC, ou `null` se não for ISO estrito ou estiver fora de [piso, now + 2 min]. */
function toQuoteTime(raw: unknown, nowMs: number): string | null {
  if (typeof raw !== "string" || raw.length > 40 || !QuoteTimeSchema.safeParse(raw).success) {
    return null;
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms < MIN_QUOTE_TIME_MS || ms > nowMs + CLOCK_SKEW_MS) return null;
  return new Date(ms).toISOString();
}

/** Remove caracteres de controle e de formatação, junta espaços e limita o tamanho. */
function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw
    .slice(0, MAX_NAME_LENGTH * 4)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return text === "" ? null : text;
}

function assertSymbol(symbol: unknown): asserts symbol is string {
  if (typeof symbol !== "string" || !SYMBOL_RE.test(symbol)) {
    throw new ValidationError("Símbolo inválido");
  }
}

export interface BrapiProviderOptions {
  /** `BRAPI_BASE_URL` (só da configuração). */
  baseUrl: string;
  /** `BRAPI_TOKEN`: vai no cabeçalho `Authorization`, nunca na URL. */
  token?: string | undefined;
  timeoutMs: number;
  maxBytes: number;
  fetchImpl?: typeof fetch;
  logger?: MarketLogger;
  /** Relógio (`CLOCK`): limita a hora das cotações e a data das barras ao presente. */
  now: Clock;
}

export class BrapiProvider implements MarketDataProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly logger: MarketLogger;

  constructor(private readonly opts: BrapiProviderOptions) {
    const base = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.fetchImpl = withNetworkRetry(base);
    this.logger = opts.logger ?? defaultMarketLogger();
  }

  async fetchQuotes(symbols: string[]): Promise<RawQuote[]> {
    if (symbols.length > MAX_SYMBOLS_PER_CALL) {
      throw new ValidationError(`No máximo ${String(MAX_SYMBOLS_PER_CALL)} símbolos por consulta`);
    }
    for (const symbol of symbols) assertSymbol(symbol);
    if (symbols.length === 0) return [];

    const requested = [...new Set(symbols)];
    const url = buildProviderUrl(this.opts.baseUrl, ["quote", requested]);
    const results = await this.fetchResults(url);

    const wanted = new Set(requested);
    const seen = new Set<string>();
    const quotes: RawQuote[] = [];
    const nowMs = this.opts.now();
    for (const item of results) {
      const quote = this.toQuote(item, wanted, nowMs);
      if (quote === null || seen.has(quote.symbol)) continue;
      seen.add(quote.symbol);
      quotes.push(quote);
    }
    return quotes;
  }

  async fetchHistory(symbol: string, range: HistoryRange): Promise<HistoricalBar[]> {
    assertSymbol(symbol);
    const validRange = HistoryRangeSchema.safeParse(range);
    if (!validRange.success) throw new ValidationError("Período inválido");

    const url = buildProviderUrl(this.opts.baseUrl, ["quote", symbol], {
      range: validRange.data,
      interval: "1d",
    });
    const results = await this.fetchResults(url);

    let rawBars: unknown[] | undefined;
    for (const item of results) {
      const entry = HistoryItemSchema.safeParse(item);
      if (entry.success && entry.data.symbol === symbol) {
        rawBars = entry.data.historicalDataPrice;
        break;
      }
    }
    if (rawBars === undefined) return [];

    // Barra de dia futuro (no calendário de São Paulo) é descartada; a de hoje vale.
    const today = SAO_PAULO_DATE.format(new Date(this.opts.now()));
    const bars: HistoricalBar[] = [];
    for (const raw of rawBars) {
      const bar = toBar(raw, today);
      if (bar !== null) bars.push(bar);
    }
    // Ordem por data (estável) e uma barra por dia: a primeira recebida vence.
    bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return bars.filter((bar, i) => i === 0 || bars[i - 1]?.date !== bar.date);
  }

  /**
   * `results` da resposta. O 404 com o corpo de erro da brapi (nenhum ticker pedido existe) vira
   * lista vazia; a mensagem dele não vai para o log. Qualquer outro formato lança.
   */
  private async fetchResults(url: URL): Promise<unknown[]> {
    const headers: Record<string, string> = {};
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    const { status, body } = await safeFetchJsonResponse(url, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.opts.timeoutMs,
      maxBytes: this.opts.maxBytes,
      headers,
      logger: this.logger,
      allowStatuses: [404],
    });
    if (status === 404) {
      if (BrapiNotFoundSchema.safeParse(body).success) return [];
      throw this.badShape(url, status);
    }
    const parsed = QuoteResponseSchema.safeParse(body);
    if (!parsed.success) throw this.badShape(url, status);
    return parsed.data.results;
  }

  /** Resposta 2xx com JSON fora do formato: os detalhes do Zod não vão para o log (trazem valores). */
  private badShape(url: URL, status: number): MarketDataUnavailableError {
    this.logger.warn({ msg: "Resposta da brapi fora do formato esperado", host: url.host, status });
    return new MarketDataUnavailableError();
  }

  /** Item da brapi -> `RawQuote`, ou `null` (descartado) se qualquer campo obrigatório não presta. */
  private toQuote(item: unknown, wanted: ReadonlySet<string>, nowMs: number): RawQuote | null {
    const parsed = QuoteItemSchema.safeParse(item);
    if (!parsed.success) return null;
    const raw = parsed.data;
    if (!SYMBOL_RE.test(raw.symbol) || !wanted.has(raw.symbol)) return null;
    if (raw.currency !== undefined && raw.currency !== null && raw.currency !== "BRL") return null;
    const price = toPrice(raw.regularMarketPrice);
    const updatedAt = toQuoteTime(raw.regularMarketTime, nowMs);
    if (price === null || updatedAt === null) return null;

    const candidate: RawQuote = {
      symbol: raw.symbol,
      name: cleanName(raw.shortName) ?? cleanName(raw.longName) ?? raw.symbol,
      assetClass: inferAssetClass(raw.symbol),
      price,
      changePct: toChangePct(raw.regularMarketChangePercent),
      previousClose: toPrice(raw.regularMarketPreviousClose),
      volume: toVolume(raw.regularMarketVolume),
      currency: "BRL",
      updatedAt,
      source: "brapi",
    };
    // Última barreira: nada sai daqui sem passar pelo contrato compartilhado.
    const checked = RawQuoteSchema.safeParse(candidate);
    return checked.success ? checked.data : null;
  }
}

function toBar(raw: unknown, today: string): HistoricalBar | null {
  const parsed = BarSchema.safeParse(raw);
  if (!parsed.success) return null;
  const b = parsed.data;
  const open = toPrice(b.open);
  const high = toPrice(b.high);
  const low = toPrice(b.low);
  const close = toPrice(b.close);
  const volume = toVolume(b.volume);
  if (open === null || high === null || low === null || close === null || volume === null) {
    return null;
  }
  const date = SAO_PAULO_DATE.format(new Date(b.date * 1000));
  if (date > today) return null;
  const candidate = {
    date,
    open,
    high,
    low,
    close,
    volume,
  };
  const checked = HistoricalBarSchema.safeParse(candidate);
  return checked.success ? checked.data : null;
}
