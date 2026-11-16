import { z } from "zod";

/**
 * Preço como string decimal não negativa (até 12 dígitos inteiros e 6 casas): nunca `number`, para
 * não perder precisão nem aceitar notação científica.
 */
export const PriceSchema = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, "preço decimal inválido");
export type Price = z.infer<typeof PriceSchema>;

/** Decimal com sinal opcional e até 6 casas (variação percentual, indicadores macro). */
const SignedDecimalSchema = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,6})?$/, "decimal com sinal inválido");

export const MarketStateSchema = z.enum(["open", "closed"]);
export type MarketState = z.infer<typeof MarketStateSchema>;

export const HISTORY_RANGES = ["5d", "1mo", "3mo", "6mo", "1y", "2y", "5y"] as const;
export const HistoryRangeSchema = z.enum(HISTORY_RANGES);
export type HistoryRange = z.infer<typeof HistoryRangeSchema>;

export const QuoteSchema = z.object({
  symbol: z.string().min(1),
  name: z.string().min(1),
  assetClass: z.enum(["stock", "bdr", "fund", "index", "unknown"]),
  price: PriceSchema,
  changePct: SignedDecimalSchema.nullable(),
  previousClose: PriceSchema.nullable(),
  volume: z
    .string()
    .regex(/^\d{1,18}$/, "volume inválido")
    .nullable(),
  currency: z.literal("BRL"),
  updatedAt: z.string().datetime(),
  marketState: MarketStateSchema,
  source: z.enum(["brapi", "mock"]),
});
export type Quote = z.infer<typeof QuoteSchema>;

export const HistoricalBarSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "data deve ser YYYY-MM-DD"),
  open: PriceSchema,
  high: PriceSchema,
  low: PriceSchema,
  close: PriceSchema,
  volume: z.string().regex(/^\d{1,18}$/, "volume inválido"),
});
export type HistoricalBar = z.infer<typeof HistoricalBarSchema>;

export const MacroIndicatorSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  value: SignedDecimalSchema,
  unit: z.string().min(1),
  referenceDate: z.string().min(1),
});
export type MacroIndicator = z.infer<typeof MacroIndicatorSchema>;

/** Cada consulta de mercado é cobrada como `data_query` a R$ 0,05. */
export const MarketUsageSchema = z.object({
  workType: z.literal("data_query"),
  priceBrl: z.literal("0.05"),
});
export type MarketUsage = z.infer<typeof MarketUsageSchema>;

export const MarketQuotesResponseSchema = z.object({
  quotes: z.array(QuoteSchema),
  usage: MarketUsageSchema,
});
export type MarketQuotesResponse = z.infer<typeof MarketQuotesResponseSchema>;

export const MarketHistoryResponseSchema = z.object({
  symbol: z.string().min(1),
  range: HistoryRangeSchema,
  bars: z.array(HistoricalBarSchema),
  usage: MarketUsageSchema,
});
export type MarketHistoryResponse = z.infer<typeof MarketHistoryResponseSchema>;

export const MarketMacroResponseSchema = z.object({
  indicators: z.array(MacroIndicatorSchema),
  usage: MarketUsageSchema,
});
export type MarketMacroResponse = z.infer<typeof MarketMacroResponseSchema>;
