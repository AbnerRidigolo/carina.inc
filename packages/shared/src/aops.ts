import { z } from "zod";
import { WorkTypeSchema } from "./billing.js";
import { ExternalIdSchema } from "./ingestion.js";
import { MoneySchema } from "./money.js";

/**
 * Agentes que um AOP pode acionar: os especialistas do chat. `executor` e `navigator` ficam de
 * fora de propósito (ação irreversível só pela caixa de entrada com aprovação).
 */
export const AopAgentSchema = z.enum([
  "insight",
  "predictor",
  "risk",
  "strategist",
  "tax",
  "researcher",
  "assessor_liaison",
]);
export type AopAgent = z.infer<typeof AopAgentSchema>;

/** Máximo de agentes por AOP (o mesmo `MAX_SPECIALISTS` do chat). */
export const AOP_MAX_AGENTS = 3;
export const AOP_MAX_CLIENTS = 20;
/** Máximo de AOPs por tenant (ligados ou não), imposto na criação. */
export const AOP_MAX_PER_TENANT = 50;

/**
 * Agenda do AOP. A hora é em America/Sao_Paulo (o Brasil não tem horário de verão, UTC-3 fixo).
 * `weekday`: 0=segunda … 6=domingo (usado em `weekly`); `day`: 1..28 (usado em `monthly`).
 * Padrão: semanal, sexta, 9h.
 */
export const ScheduleSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly"]).default("weekly"),
  weekday: z.number().int().min(0).max(6).default(4),
  day: z.number().int().min(1).max(28).default(1),
  hour: z.number().int().min(0).max(23).default(9),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export const AopNameSchema = z.string().min(1).max(120);
export const AopDescriptionSchema = z.string().min(1).max(2000);
const AopClientIdsSchema = z.array(ExternalIdSchema).min(1).max(AOP_MAX_CLIENTS);

export const AopSchema = z.object({
  id: z.uuid(),
  name: AopNameSchema,
  /** O texto original em linguagem natural. */
  description: AopDescriptionSchema,
  agents: z.array(AopAgentSchema).min(1).max(AOP_MAX_AGENTS),
  schedule: ScheduleSchema,
  clientIds: AopClientIdsSchema,
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
  lastFireAt: z.iso.datetime().nullable(),
});
export type Aop = z.infer<typeof AopSchema>;

export const AopCreateSchema = z
  .object({
    description: AopDescriptionSchema,
    clientIds: AopClientIdsSchema,
    name: AopNameSchema.optional(),
  })
  .strict();
export type AopCreate = z.infer<typeof AopCreateSchema>;

export const AopUpdateSchema = z.object({ enabled: z.boolean() }).strict();
export type AopUpdate = z.infer<typeof AopUpdateSchema>;

export const AopRunSchema = z.object({
  id: z.uuid(),
  aopId: z.uuid(),
  clientId: ExternalIdSchema,
  /** O horário agendado, ou o instante do disparo manual. */
  fireAt: z.iso.datetime(),
  trigger: z.enum(["schedule", "manual"]),
  status: z.enum(["ok", "failed", "skipped"]),
  failureCode: z.enum(["client_not_found", "quota_exceeded", "agents_failed"]).nullable(),
  /** Por agente: a saída validada ou `{ failed: true }`. */
  results: z.record(z.string(), z.unknown()),
  workType: WorkTypeSchema.nullable(),
  priceBrl: MoneySchema.nullable(),
  createdAt: z.iso.datetime(),
});
export type AopRun = z.infer<typeof AopRunSchema>;

export const AopRunPageSchema = z.object({
  items: z.array(AopRunSchema),
  nextCursor: z.string().nullable(),
});
export type AopRunPage = z.infer<typeof AopRunPageSchema>;
