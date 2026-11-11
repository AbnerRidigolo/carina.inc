import { z } from "zod";
import { MoneySchema, QuantitySchema } from "./money.js";

export const NormalizedPositionSchema = z.object({
  externalId: z.string().min(1).max(128),
  institution: z.string(),
  kind: z.enum(["investment", "cash"]),
  assetClass: z.enum(["acao", "fii", "tesouro", "renda_fixa", "fundo", "caixa"]),
  assetCode: z.string().optional(),
  name: z.string(),
  quantity: QuantitySchema.optional(),
  valueBrl: MoneySchema,
  asOf: z.iso.date(),
});
export type NormalizedPosition = z.infer<typeof NormalizedPositionSchema>;

export const NormalizedTransactionSchema = z.object({
  externalId: z.string().min(1).max(128),
  institution: z.string(),
  account: z.string(),
  date: z.iso.date(),
  description: z.string(),
  amountBrl: MoneySchema,
  kind: z.enum(["debit", "credit", "buy", "sell", "dividend", "jcp", "fee", "tax"]),
  category: z.string().optional(),
  assetCode: z.string().optional(),
  quantity: QuantitySchema.optional(),
});
export type NormalizedTransaction = z.infer<typeof NormalizedTransactionSchema>;

export const PositionBatchSchema = z.object({
  items: z.array(NormalizedPositionSchema).min(1).max(1000),
});
export type PositionBatch = z.infer<typeof PositionBatchSchema>;

export const TransactionBatchSchema = z.object({
  items: z.array(NormalizedTransactionSchema).min(1).max(1000),
});
export type TransactionBatch = z.infer<typeof TransactionBatchSchema>;

const streamBase = {
  eventId: z.uuid(),
  tenantId: z.string(),
  clientId: z.string(),
};

export const StreamEventSchema = z.discriminatedUnion("type", [
  z.object({ ...streamBase, type: z.literal("approval.created"), approvalId: z.string() }),
  z.object({
    ...streamBase,
    type: z.literal("approval.executed"),
    approvalId: z.string(),
    status: z.enum(["succeeded", "failed"]),
  }),
  z.object({
    ...streamBase,
    type: z.literal("resume"),
    approvalId: z.string(),
    threadId: z.string(),
    approved: z.boolean(),
  }),
  z.object({ ...streamBase, type: z.literal("data.ingested"), source: z.string() }),
  z.object({
    ...streamBase,
    type: z.literal("notification"),
    kind: z.string(),
    text: z.string(),
  }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;
