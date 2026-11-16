import {
  HistoryRangeSchema,
  type HistoryRange,
  type MarketHistoryResponse,
  type MarketMacroResponse,
  type MarketQuotesResponse,
  MarketUsageSchema,
  type MarketUsage,
} from "@carina/shared";
import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { ZodValidationPipe } from "nestjs-zod";
import { z } from "zod";
import { BillingService } from "../billing/billing.service.js";
import { PRICE_BRL } from "../billing/pricing.js";
import { CLOCK, type Clock } from "../limits/clock.js";
import { RequireScopes } from "../tenancy/scopes.decorator.js";
import { SYMBOL_RE } from "./asset-class.js";
import { MAX_SYMBOLS, MarketService } from "./market.service.js";

/** O preço devolvido vem da mesma tabela que o billing cobra. */
const USAGE = MarketUsageSchema.parse({
  workType: "data_query",
  priceBrl: PRICE_BRL.data_query,
}) satisfies MarketUsage;

/**
 * `?symbols=A,B`: separa por vírgula, apara espaços e descarta itens vazios. Nada é posto em
 * maiúsculas em silêncio (`petr4` é 422); repetidos viram um; 0 ou mais de 20 → 422.
 */
export const QuotesQuerySchema = z.object({
  symbols: z
    .string()
    .transform((raw) =>
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    )
    .pipe(
      z
        .array(z.string().regex(SYMBOL_RE, "símbolo inválido"))
        .min(1, "informe ao menos um símbolo")
        .transform((list) => [...new Set(list)])
        .pipe(z.array(z.string()).max(MAX_SYMBOLS, `no máximo ${String(MAX_SYMBOLS)} símbolos`)),
    ),
});
type QuotesQuery = z.output<typeof QuotesQuerySchema>;

const SymbolParamSchema = z.string().regex(SYMBOL_RE, "símbolo inválido");
export const HistoryQuerySchema = z.object({ range: HistoryRangeSchema.default("3mo") });
type HistoryQuery = z.output<typeof HistoryQuerySchema>;

/**
 * Dados de mercado (escopo `market:read`). Cada chamada bem-sucedida (inclusive acerto de cache)
 * é cobrada como `data_query` DEPOIS que o serviço respondeu; falha propaga sem `record`. Não
 * reserva cota mensal (como a ingestão).
 */
@Controller("market")
export class MarketController {
  constructor(
    @Inject(MarketService) private readonly market: MarketService,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get("quotes")
  @RequireScopes("market:read")
  async quotes(
    @Query(new ZodValidationPipe(QuotesQuerySchema)) query: QuotesQuery,
  ): Promise<MarketQuotesResponse> {
    const started = this.clock();
    const quotes = await this.market.quotes(query.symbols);
    await this.bill(started);
    return { quotes, usage: USAGE };
  }

  @Get("history/:symbol")
  @RequireScopes("market:read")
  async history(
    @Param("symbol", new ZodValidationPipe(SymbolParamSchema)) symbol: string,
    @Query(new ZodValidationPipe(HistoryQuerySchema)) query: HistoryQuery,
  ): Promise<MarketHistoryResponse> {
    const started = this.clock();
    const range: HistoryRange = query.range;
    const bars = await this.market.history(symbol, range);
    await this.bill(started);
    return { symbol, range, bars, usage: USAGE };
  }

  @Get("macro")
  @RequireScopes("market:read")
  async macro(): Promise<MarketMacroResponse> {
    const started = this.clock();
    const indicators = await this.market.macro();
    await this.bill(started);
    return { indicators, usage: USAGE };
  }

  private async bill(started: number): Promise<void> {
    await this.billing.record({
      workType: "data_query",
      agents: [],
      durationMs: Math.max(0, Math.round(this.clock() - started)),
    });
  }
}
