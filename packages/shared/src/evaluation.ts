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

/**
 * Formato de um id de caso: o que os 42 ids do dataset usam. Limita o tamanho do que um erro pode
 * repetir e recusa chaves como `__proto__`, que o parse de record descartaria em silêncio.
 */
export const EVAL_CASE_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

/**
 * Confere as chaves no objeto CRU, antes do `z.record`: (1) o issue de chave inválida do record
 * repete a chave inteira no `path` (e daí no `detail` do 422), e aqui a mensagem é fixa, sem a
 * chave; (2) o record descarta `__proto__` sem erro, e aqui ele é recusado.
 *
 * Um id repetido não chega aqui: o `JSON.parse` do corpo fica só com a última ocorrência.
 */
const AnswerKeysSchema = z.unknown().superRefine((value, ctx) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const invalid = Object.keys(value).filter((k) => !EVAL_CASE_ID_PATTERN.test(k)).length;
  if (invalid > 0) {
    ctx.addIssue({
      code: "custom",
      message: `${String(invalid)} id(s) de caso fora do formato ${EVAL_CASE_ID_PATTERN.source}`,
    });
  }
});

export const EvalSubmitSchema = z.object({
  answers: AnswerKeysSchema.pipe(
    z.record(z.string(), z.string().max(EVAL_MAX_ANSWER_CHARS)),
  ).refine((a) => Object.keys(a).length >= 1 && Object.keys(a).length <= EVAL_MAX_ANSWERS, {
    message: `envie de 1 a ${EVAL_MAX_ANSWERS} respostas`,
  }),
});
export type EvalSubmit = z.infer<typeof EvalSubmitSchema>;

/**
 * Resultado de um caso: só contagens. As descrições dos fatos (o que o Python devolvia em
 * `matched`/`missing`/`forbidden_hits`) ficam na API, senão uma submissão de R$ 5,00 com "x" em
 * todos os casos colheria o gabarito inteiro.
 */
export const EvalCaseResultSchema = z
  .object({
    caseId: z.string().min(1),
    category: EvalCategorySchema,
    score: z.number().min(0).max(1),
    passed: z.boolean(),
    factsTotal: z.number().int().positive(),
    factsMatched: z.number().int().nonnegative(),
    forbiddenHits: z.number().int().nonnegative(),
    complianceFlags: z.array(ComplianceFlagSchema),
  })
  .refine((r) => r.factsMatched <= r.factsTotal, {
    message: "factsMatched não pode passar de factsTotal",
    path: ["factsMatched"],
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
