import { z } from "zod";
import { AgentNameSchema, PlanSchema } from "./agents.js";
import { ComplianceFlagSchema } from "./audit.js";
import { WorkTypeSchema } from "./billing.js";
import { ApprovalViewSchema } from "./inbox.js";
import { MoneySchema } from "./money.js";

export const ChatClientIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const MAX_CHAT_MESSAGE_CHARS = 8000;
/** `tenantId:clientId:<id>` (36 + 1 + 36 + 1 + até 128); o limite só barra entradas absurdas. */
export const MAX_THREAD_ID_CHARS = 256;

/** Corpo de `POST /api/chat` e mensagem do WebSocket: estrito (campo desconhecido → 422). */
export const ChatRequestSchema = z
  .object({
    clientId: ChatClientIdSchema,
    message: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_CHARS),
    threadId: z.string().max(MAX_THREAD_ID_CHARS).optional(),
  })
  .strict();
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** Status de um turno (o `awaiting_approval` vem do banco: aprovação pendente e não vencida). */
export const ChatTurnStatusSchema = z.enum(["completed", "awaiting_approval"]);
export type ChatTurnStatus = z.infer<typeof ChatTurnStatusSchema>;

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
    status: ChatTurnStatusSchema,
    answer: z.string(),
    usage: z.object({ workType: WorkTypeSchema, priceBrl: MoneySchema }),
    compliance: z.object({ auditId: z.string(), flags: z.array(ComplianceFlagSchema) }),
  }),
  z.object({ type: z.literal("error"), code: z.string(), traceId: z.string() }),
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;

/** Resposta consolidada de `POST /api/chat`. */
export const ChatResponseSchema = z.object({
  threadId: z.string(),
  status: ChatTurnStatusSchema,
  plan: PlanSchema,
  /** Resultado de cada agente do turno (especialistas e executor); a resposta vai em `answer`. */
  results: z.record(z.string(), z.unknown()),
  answer: z.string(),
  approval: ApprovalViewSchema.optional(),
  usage: z.object({ workType: WorkTypeSchema, priceBrl: MoneySchema }),
  compliance: z.object({ auditId: z.string(), flags: z.array(ComplianceFlagSchema) }),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

/** Corpo de `POST /api/ws/ticket`: a conexão fica presa a este cliente final. */
export const WsTicketRequestSchema = z.object({ clientId: ChatClientIdSchema }).strict();
export type WsTicketRequest = z.infer<typeof WsTicketRequestSchema>;

export const WS_TICKET_TTL_SECONDS = 30;
export const WsTicketSchema = z.object({
  ticket: z.string(),
  expiresInSeconds: z.literal(WS_TICKET_TTL_SECONDS),
});
export type WsTicket = z.infer<typeof WsTicketSchema>;
