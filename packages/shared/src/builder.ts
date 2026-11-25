import { z } from "zod";
import { SYMBOL_RE } from "./market.js";

/** Tipos de estratégia declarativa do MVP (porte de `StrategyKind` do Python). */
export const STRATEGY_KINDS = ["buy_hold", "sma_cross"] as const;
export const StrategyKindSchema = z.enum(STRATEGY_KINDS);
export type StrategyKind = z.infer<typeof StrategyKindSchema>;

/** Máximo de estratégias por tenant (limite nosso). */
export const STRATEGY_MAX_PER_TENANT = 100;

/**
 * Especificação declarativa: nunca código do cliente. `fast < slow` só vale para `sma_cross`;
 * `buy_hold` ignora as janelas (como no Python).
 */
export const StrategySpecSchema = z
  .object({
    kind: StrategyKindSchema,
    symbol: z.string().regex(SYMBOL_RE, "símbolo inválido"),
    fast: z.number().int().min(2).max(200).default(10),
    slow: z.number().int().min(3).max(400).default(50),
  })
  .superRefine((spec, ctx) => {
    if (spec.kind === "sma_cross" && spec.fast >= spec.slow) {
      ctx.addIssue({
        code: "custom",
        path: ["fast"],
        message: "janela rápida deve ser menor que a lenta (fast < slow)",
      });
    }
  });
export type StrategySpec = z.infer<typeof StrategySpecSchema>;

export const StrategyNameSchema = z.string().trim().min(1).max(120);

export const StrategyCreateSchema = z.object({
  name: StrategyNameSchema,
  spec: StrategySpecSchema,
});
export type StrategyCreate = z.infer<typeof StrategyCreateSchema>;

export const StrategySchema = z.object({
  id: z.string().uuid(),
  name: StrategyNameSchema,
  spec: StrategySpecSchema,
  createdAt: z.string().datetime(),
});
export type Strategy = z.infer<typeof StrategySchema>;

/** Cada backtest bem-sucedido é cobrado como `backtest` a R$ 7,50. */
export const BacktestUsageSchema = z.object({
  workType: z.literal("backtest"),
  priceBrl: z.literal("7.50"),
});
export type BacktestUsage = z.infer<typeof BacktestUsageSchema>;

/** Resultado do backtest em base 100; `start`/`end` são a primeira e a última data (YYYY-MM-DD). */
export const BacktestResultSchema = z.object({
  symbol: z.string().min(1),
  kind: StrategyKindSchema,
  bars: z.number().int().nonnegative(),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totalReturnPct: z.number(),
  maxDrawdownPct: z.number(),
  annualizedVolatilityPct: z.number(),
  trades: z.number().int().nonnegative(),
  finalEquity: z.number(),
  equityCurve: z.array(z.number()),
  usage: BacktestUsageSchema,
});
export type BacktestResult = z.infer<typeof BacktestResultSchema>;
