import { z } from "zod";
import { PriceSchema, SignedDecimalSchema } from "./market.js";

/** Alerta de variação forte de um ativo da carteira (um por ativo, dia de pregão e direção). */
export const PortfolioAlertSchema = z.object({
  id: z.uuid(),
  assetCode: z.string().min(1),
  direction: z.enum(["up", "down"]),
  changePct: SignedDecimalSchema,
  price: PriceSchema,
  tradingDay: z.iso.date(),
  createdAt: z.iso.datetime(),
});
export type PortfolioAlert = z.infer<typeof PortfolioAlertSchema>;

export const PortfolioAlertPageSchema = z.object({
  items: z.array(PortfolioAlertSchema),
  nextCursor: z.string().nullable(),
});
export type PortfolioAlertPage = z.infer<typeof PortfolioAlertPageSchema>;
