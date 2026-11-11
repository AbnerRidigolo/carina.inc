import { z } from "zod";
import { AgentNameSchema } from "./agents.js";
import { MoneySchema } from "./money.js";

export const RiskClassSchema = z.enum(["read", "reversible", "irreversible"]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const ApprovalViewSchema = z.object({
  id: z.string(),
  /** externalId do cliente */
  clientId: z.string(),
  agent: AgentNameSchema,
  action: z.string(),
  risk: RiskClassSchema,
  payload: z.record(z.string(), z.unknown()),
  valueBrl: MoneySchema,
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;

export const DecisionRequestSchema = z.object({
  approved: z.boolean(),
  reason: z.string().max(500).optional(),
});
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;
