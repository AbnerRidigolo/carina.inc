import { z } from "zod";
import { AgentNameSchema, PlanSchema } from "./agents.js";
import { ComplianceFlagSchema } from "./audit.js";
import { WorkTypeSchema } from "./billing.js";
import { ApprovalViewSchema } from "./inbox.js";
import { MoneySchema } from "./money.js";

export const ChatRequestSchema = z.object({
  clientId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  message: z.string().trim().min(1).max(8000),
  threadId: z.string().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("plan"), plan: PlanSchema }),
  z.object({ type: z.literal("agent_started"), agent: AgentNameSchema }),
  z.object({ type: z.literal("token"), agent: AgentNameSchema, text: z.string() }),
  z.object({ type: z.literal("agent_result"), agent: AgentNameSchema, result: z.unknown() }),
  z.object({ type: z.literal("approval_required"), approval: ApprovalViewSchema }),
  z.object({
    type: z.literal("approval_executed"),
    approvalId: z.string(),
    status: z.enum(["succeeded", "failed"]),
    result: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("done"),
    threadId: z.string(),
    status: z.enum(["completed", "awaiting_approval"]),
    answer: z.string(),
    usage: z.object({ workType: WorkTypeSchema, priceBrl: MoneySchema }),
    compliance: z.object({ auditId: z.string(), flags: z.array(ComplianceFlagSchema) }),
  }),
  z.object({ type: z.literal("error"), code: z.string(), traceId: z.string() }),
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;
