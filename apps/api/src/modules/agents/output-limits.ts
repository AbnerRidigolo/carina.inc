/**
 * Limites das saídas estruturadas do Predictor, Risk, Strategist, Tax e Assessor Liaison (a saída
 * do modelo é não confiável). Aplicados como `refine` depois do schema Zod, no mesmo estilo do
 * Executor. Violação = `AllProvidersFailedError` (mesmo contrato das demais saídas ruins do
 * modelo).
 *
 * Limites escolhidos (generosos para uso real, baratos para quem abusa):
 * - texto de item (nome, premissa, achado, sugestão, correlação): até 500 caracteres;
 * - narrativa: até 5000 caracteres;
 * - listas: até 20 itens; cenários: até 6;
 * - `driftPct`: finito, |valor| <= 1000;
 * - dinheiro: string decimal já limitada pelo MoneySchema (até 16 dígitos inteiros e 2 casas,
 *   ou seja < 1e16 = MAX_MONEY_BRL); aqui exigimos também valor finito, e não negativo no VaR e no
 *   `valueBrl` do Executor (fluxo líquido projetado pode ser negativo).
 */
import type {
  AssessorBrief,
  CashFlowForecast,
  RiskAssessment,
  StrategyPlan,
  TaxAdvice,
} from "@carina/shared";
import { AllProvidersFailedError } from "../../core/errors/domain-errors.js";

export const MAX_ITEM_CHARS = 500;
export const MAX_NARRATIVE_CHARS = 5000;
export const MAX_LIST_ITEMS = 20;
export const MAX_SCENARIOS = 6;
export const MAX_ABS_DRIFT_PCT = 1000;
export const MAX_MONEY_BRL = 1e16;
const MAX_MONEY_DIGITS = 16;

const bad = (): AllProvidersFailedError => new AllProvidersFailedError();

export function checkMoney(value: string, opts: { nonNegative: boolean }): void {
  // Comparação por texto (Number arredonda 9999999999999999.99 para 1e16): no máximo 16 dígitos
  // inteiros, ou seja, valor < MAX_MONEY_BRL.
  const intDigits = value.replace(/^-/, "").split(".")[0]?.length ?? 0;
  if (!Number.isFinite(Number(value)) || intDigits > MAX_MONEY_DIGITS) throw bad();
  if (opts.nonNegative && value.startsWith("-")) throw bad();
}

function checkTexts(items: string[], maxItems = MAX_LIST_ITEMS): void {
  if (items.length > maxItems) throw bad();
  for (const s of items) if (s.length > MAX_ITEM_CHARS) throw bad();
}

export function refineForecast(f: CashFlowForecast): CashFlowForecast {
  if (f.scenarios.length > MAX_SCENARIOS) throw bad();
  if (f.narrative.length > MAX_NARRATIVE_CHARS) throw bad();
  for (const s of f.scenarios) {
    checkTexts([s.name]);
    checkTexts(s.assumptions);
    checkMoney(s.projectedNetFlowBrl, { nonNegative: false });
  }
  return f;
}

export function refineRisk(r: RiskAssessment): RiskAssessment {
  if (!Number.isFinite(r.driftPct) || Math.abs(r.driftPct) > MAX_ABS_DRIFT_PCT) throw bad();
  checkMoney(r.valueAtRiskBrl, { nonNegative: true });
  checkTexts(r.topCorrelations);
  checkTexts(r.stressFindings);
  checkTexts(r.rebalanceSuggestions);
  return r;
}

const ALLOCATION_TOLERANCE = 0.5;

export function refineStrategy(p: StrategyPlan): StrategyPlan {
  if (p.narrative.length > MAX_NARRATIVE_CHARS) throw bad();
  if (p.targetAllocation.length > MAX_LIST_ITEMS || p.milestones.length > MAX_LIST_ITEMS) {
    throw bad();
  }
  let sum = 0;
  for (const a of p.targetAllocation) {
    // O schema não limita pct: finito e em 0..100 é conferido aqui.
    if (!Number.isFinite(a.pct) || a.pct < 0 || a.pct > 100) throw bad();
    checkTexts([a.assetClass]);
    sum += a.pct;
  }
  if (Math.abs(sum - 100) > ALLOCATION_TOLERANCE) throw bad();
  for (const m of p.milestones) {
    if (
      !Number.isFinite(m.successProbability) ||
      m.successProbability < 0 ||
      m.successProbability > 1
    ) {
      throw bad();
    }
    checkTexts([m.goal]);
  }
  checkTexts(p.assumptions);
  return p;
}

export function refineTax(t: TaxAdvice): TaxAdvice {
  checkMoney(t.estimatedTaxBrl, { nonNegative: true });
  if (t.narrative.length > MAX_NARRATIVE_CHARS || t.offshoreVsBr.length > MAX_NARRATIVE_CHARS) {
    throw bad();
  }
  checkTexts(t.harvestingOpportunities);
  checkTexts(t.actions);
  return t;
}

export function refineAssessorBrief(b: AssessorBrief): AssessorBrief {
  if (b.narrative.length > MAX_NARRATIVE_CHARS) throw bad();
  checkTexts(b.questions, 5);
  checkTexts(b.sharedData);
  return b;
}
