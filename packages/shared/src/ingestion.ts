import { z } from "zod";
import { MoneySchema, QuantitySchema } from "./money.js";

/**
 * Identificador do item no sistema do tenant (e do cliente final): 1 a 128 caracteres (pontos de
 * código), sem nenhum caractere da categoria `\p{C}` do Unicode (NUL e demais controles como TAB e
 * quebra de linha, formatação como ZWJ, hífen suave, BOM e marcas bidi, uso privado, não atribuído
 * e surrogate solto). Texto bem formado e sem invisíveis: é a mesma chave que volta no cursor de
 * paginação e que o banco guarda, então precisa sobreviver a ida e volta sem alteração.
 */
export const ExternalIdSchema = z
  .string()
  .regex(
    /^[^\p{C}]{1,128}$/u,
    "precisa ter de 1 a 128 caracteres, sem caracteres de controle, de formatação ou inválidos",
  );
export type ExternalId = z.infer<typeof ExternalIdSchema>;

export const NormalizedPositionSchema = z.object({
  externalId: ExternalIdSchema,
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
  externalId: ExternalIdSchema,
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
