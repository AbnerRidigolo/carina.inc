import { z } from "zod";
import { ComplianceFlagSchema } from "./audit.js";

/**
 * Contratos do benchmark SEAL BR. Só a visão pública: o gabarito (fatos esperados, proibidos e
 * referência) fica na API e nunca entra neste pacote, que vai para o bundle da web.
 */
export const EVAL_CATEGORIES = ["tributacao", "cvm", "open_finance", "produtos", "macro"] as const;
export const EvalCategorySchema = z.enum(EVAL_CATEGORIES);
export type EvalCategory = z.infer<typeof EvalCategorySchema>;

/** Máximo de respostas por submissão: o tamanho do dataset embarcado. */
export const EVAL_MAX_ANSWERS = 42;
/** Tamanho máximo do texto de uma resposta (limite nosso). */
export const EVAL_MAX_ANSWER_CHARS = 20_000;

/** Pergunta do catálogo: sem gabarito nem referência (campos extras do input são descartados). */
export const EvalCaseViewSchema = z.object({
  id: z.string().min(1),
  category: EvalCategorySchema,
  difficulty: z.string().min(1),
  question: z.string().min(1),
});
export type EvalCaseView = z.infer<typeof EvalCaseViewSchema>;

export const EvalSubmitSchema = z.object({
  answers: z
    .record(z.string().min(1), z.string().max(EVAL_MAX_ANSWER_CHARS))
    .refine((a) => Object.keys(a).length >= 1 && Object.keys(a).length <= EVAL_MAX_ANSWERS, {
      message: `envie de 1 a ${EVAL_MAX_ANSWERS} respostas`,
    }),
});
export type EvalSubmit = z.infer<typeof EvalSubmitSchema>;

export const EvalCaseResultSchema = z.object({
  caseId: z.string().min(1),
  category: EvalCategorySchema,
  score: z.number().min(0).max(1),
  passed: z.boolean(),
  matched: z.array(z.string()),
  missing: z.array(z.string()),
  forbiddenHits: z.array(z.string()),
  complianceFlags: z.array(ComplianceFlagSchema),
});
export type EvalCaseResult = z.infer<typeof EvalCaseResultSchema>;

export const EvalCategoryStatsSchema = z.object({
  answered: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  avgScore: z.number().min(0).max(1),
});
export type EvalCategoryStats = z.infer<typeof EvalCategoryStatsSchema>;

/** Cada submissão corrigida é cobrada como `evaluation` a R$ 5,00. */
export const EvalUsageSchema = z.object({
  workType: z.literal("evaluation"),
  priceBrl: z.literal("5.00"),
});
export type EvalUsage = z.infer<typeof EvalUsageSchema>;

export const EvalReportSchema = z.object({
  answered: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1),
  avgScore: z.number().min(0).max(1),
  complianceViolations: z.number().int().nonnegative(),
  byCategory: z.partialRecord(EvalCategorySchema, EvalCategoryStatsSchema),
  results: z.array(EvalCaseResultSchema),
  usage: EvalUsageSchema,
});
export type EvalReport = z.infer<typeof EvalReportSchema>;
