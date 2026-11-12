import { z } from "zod";
import { MoneySchema } from "./money.js";

export const WorkTypeSchema = z.enum([
  "query",
  "analysis",
  "multi_agent_analysis",
  "optimization",
  "execution",
  "data_query",
  "data_ingestion",
  "evaluation",
  "backtest",
]);
export type WorkType = z.infer<typeof WorkTypeSchema>;

export const UsageSummarySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  resolutions: z.number().int().nonnegative(),
  totalBrl: MoneySchema,
  byWorkType: z.partialRecord(
    WorkTypeSchema,
    z.object({ count: z.number().int().nonnegative(), totalBrl: MoneySchema }),
  ),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;
