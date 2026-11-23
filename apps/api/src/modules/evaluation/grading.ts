/**
 * Motor de correção determinística do SEAL BR.
 *
 * Port de `legacy/python/carina/data_engine/evaluation.py`: a correção é por presença de fatos
 * (substring normalizada), sem LLM-judge, para ser reproduzível e auditável. Cada resposta também
 * passa pelas checagens de compliance do Watchtower.
 */
import type {
  EvalCaseResult,
  EvalCaseView,
  EvalCategory,
  EvalCategoryStats,
  EvalReport,
} from "@carina/shared";
import { ValidationError } from "../../core/errors/domain-errors.js";
import { inspectText } from "../watchtower/inspect-text.js";
import { EVAL_DATASET, type EvalCase, type ExpectedFact } from "./dataset.js";

/** Normaliza para comparação: minúsculas, `,` → `.`, NFKD sem acentos, espaços colapsados. */
export function normalize(text: string): string {
  const stripped = text.toLowerCase().replaceAll(",", ".").normalize("NFKD");
  const noAccents = stripped.replace(/\p{M}/gu, "");
  return noAccents.split(/\s+/u).filter(Boolean).join(" ");
}

function presentIn(fact: ExpectedFact, normalizedAnswer: string): boolean {
  return fact.alternatives.some((alt) => normalizedAnswer.includes(normalize(alt)));
}

/**
 * `round(x, 4)` do Python: arredonda a 4 casas, com empate exato (representável em binário, como
 * 0.03125) indo para o par, como o `round` do Python. Fora de empates exatos, `toFixed` (que usa o
 * valor exato do double) dá o mesmo resultado do Python. Com ≤ 4 fatos por caso, o score nunca
 * empata; o desempate só importa para médias.
 */
export function round4(x: number): number {
  const fixed = x.toFixed(4);
  const exact = x.toFixed(40);
  const dot = exact.indexOf(".");
  const tail = exact.slice(dot + 1 + 4);
  if (/^50*$/.test(tail)) {
    // Empate exato: toFixed arredondou para longe de zero; escolhe o par.
    const down = exact.slice(0, dot + 1 + 4);
    const lastDigit = Number(down.at(-1));
    return Number(lastDigit % 2 === 0 ? down : fixed);
  }
  return Number(fixed);
}

/**
 * Corrige um caso. O resultado só traz contagens (fatos esperados, encontrados e proibidos): as
 * descrições do gabarito nunca saem do servidor, ao contrário do Python, que as devolvia.
 */
export function gradeCase(c: EvalCase, answer: string): EvalCaseResult {
  const normalized = normalize(answer);
  const factsMatched = c.expectedFacts.filter((f) => presentIn(f, normalized)).length;
  const forbiddenHits = c.forbidden.filter((f) => presentIn(f, normalized)).length;
  const factsTotal = c.expectedFacts.length;
  return {
    caseId: c.id,
    category: c.category,
    score: round4(factsMatched / factsTotal),
    passed: factsMatched === factsTotal && forbiddenHits === 0,
    factsTotal,
    factsMatched,
    forbiddenHits,
    complianceFlags: inspectText(answer),
  };
}

/** Catálogo público: pergunta SEM gabarito nem referência. */
export function catalog(category?: EvalCategory): EvalCaseView[] {
  return EVAL_DATASET.filter((c) => category === undefined || c.category === category).map((c) => ({
    id: c.id,
    category: c.category,
    difficulty: c.difficulty,
    question: c.question,
  }));
}

const BY_ID: ReadonlyMap<string, EvalCase> = new Map(EVAL_DATASET.map((c) => [c.id, c]));

/** Quantos ids inexistentes a mensagem de erro lista; o resto vira "e mais K". */
const MAX_LISTED_UNKNOWN = 10;

/**
 * Corrige `{ caseId: resposta }`. Execução parcial é permitida. Ids inexistentes lançam
 * `ValidationError` listando só os ids (nunca o texto das respostas), no máximo 10.
 */
export function evaluate(answers: Record<string, string>): Omit<EvalReport, "usage"> {
  const unknown = Object.keys(answers)
    .filter((id) => !BY_ID.has(id))
    .sort();
  if (unknown.length > 0) {
    const listed = unknown.slice(0, MAX_LISTED_UNKNOWN).join(", ");
    const rest = unknown.length - MAX_LISTED_UNKNOWN;
    throw new ValidationError(
      `Casos inexistentes no benchmark: ${listed}${rest > 0 ? ` e mais ${String(rest)}` : ""}`,
    );
  }

  const results = Object.keys(answers)
    .sort()
    .map((id) => gradeCase(BY_ID.get(id) as EvalCase, answers[id] as string));
  const passed = results.filter((r) => r.passed).length;
  const complianceViolations = results.reduce((n, r) => n + r.complianceFlags.length, 0);

  const sums = new Map<EvalCategory, EvalCategoryStats>();
  for (const r of results) {
    const b = sums.get(r.category) ?? { answered: 0, passed: 0, avgScore: 0 };
    b.answered += 1;
    b.passed += r.passed ? 1 : 0;
    b.avgScore += r.score;
    sums.set(r.category, b);
  }
  const byCategory: Partial<Record<EvalCategory, EvalCategoryStats>> = {};
  for (const [cat, b] of sums) {
    byCategory[cat] = { ...b, avgScore: round4(b.avgScore / b.answered) };
  }

  return {
    answered: results.length,
    passed,
    passRate: results.length ? round4(passed / results.length) : 0,
    avgScore: results.length
      ? round4(results.reduce((s, r) => s + r.score, 0) / results.length)
      : 0,
    complianceViolations,
    byCategory,
    results,
  };
}
