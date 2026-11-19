import { describe, expect, it } from "vitest";
import {
  ActionProposalSchema,
  AgentNameSchema,
  AssessorBriefSchema,
  CashFlowForecastSchema,
  CashFlowScenarioSchema,
  PlanSchema,
  RiskAssessmentSchema,
  SpecialistNameSchema,
  StrategyPlanSchema,
  TaxAdviceSchema,
} from "./agents.js";

const scenario = {
  name: "base",
  horizonMonths: 12,
  assumptions: ["selic 10%"],
  projectedNetFlowBrl: "1500.00",
  confidence: 0.7,
};

const ok = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  s.safeParse(v).success;

describe("agents", () => {
  it("SpecialistName", () => {
    expect(ok(SpecialistNameSchema, "risk")).toBe(true);
    expect(ok(SpecialistNameSchema, "navigator")).toBe(false);
  });

  it("AgentName inclui navigator e executor", () => {
    for (const a of ["insight", "predictor", "risk", "navigator", "executor"]) {
      expect(ok(AgentNameSchema, a)).toBe(true);
    }
    expect(ok(AgentNameSchema, "outro")).toBe(false);
  });

  it("Plan", () => {
    const plan = {
      complexity: "média",
      agents: ["insight"],
      wantsExecution: false,
      rationale: "r",
    };
    expect(ok(PlanSchema, plan)).toBe(true);
    expect(ok(PlanSchema, { ...plan, complexity: "media" })).toBe(false);
    expect(ok(PlanSchema, { ...plan, agents: ["executor"] })).toBe(false);
  });

  it("CashFlowScenario: horizonte 12–36", () => {
    expect(ok(CashFlowScenarioSchema, scenario)).toBe(true);
    expect(ok(CashFlowScenarioSchema, { ...scenario, horizonMonths: 36 })).toBe(true);
    expect(ok(CashFlowScenarioSchema, { ...scenario, horizonMonths: 48 })).toBe(false);
    expect(ok(CashFlowScenarioSchema, { ...scenario, horizonMonths: 11 })).toBe(false);
    expect(ok(CashFlowScenarioSchema, { ...scenario, horizonMonths: 12.5 })).toBe(false);
  });

  it("CashFlowScenario: confiança 0–1 e money string", () => {
    expect(ok(CashFlowScenarioSchema, { ...scenario, confidence: 1.1 })).toBe(false);
    expect(ok(CashFlowScenarioSchema, { ...scenario, confidence: -0.1 })).toBe(false);
    expect(ok(CashFlowScenarioSchema, { ...scenario, projectedNetFlowBrl: 10 })).toBe(false);
  });

  it("CashFlowForecast exige ao menos 1 cenário", () => {
    expect(ok(CashFlowForecastSchema, { scenarios: [scenario], narrative: "n" })).toBe(true);
    expect(ok(CashFlowForecastSchema, { scenarios: [], narrative: "n" })).toBe(false);
  });

  it("RiskAssessment", () => {
    const r = {
      driftPct: 3.2,
      valueAtRiskBrl: "100.00",
      topCorrelations: [],
      stressFindings: [],
      rebalanceSuggestions: [],
    };
    expect(ok(RiskAssessmentSchema, r)).toBe(true);
    expect(ok(RiskAssessmentSchema, { ...r, valueAtRiskBrl: 100 })).toBe(false);
  });

  it("ActionProposal", () => {
    const a = { action: "buy", payload: { code: "X" }, valueBrl: "10.00", rationale: "r" };
    expect(ok(ActionProposalSchema, a)).toBe(true);
    expect(ok(ActionProposalSchema, { ...a, valueBrl: "10.123" })).toBe(false);
  });
});

describe("especialistas novos", () => {
  const milestone = { goal: "aposentadoria", byYear: 2045, successProbability: 0.8 };
  const plan = {
    targetAllocation: [{ assetClass: "renda fixa", pct: 60 }],
    milestones: [milestone],
    assumptions: ["selic 10%"],
    narrative: "plano",
  };

  it("StrategyPlan aceita plano válido e recusa pct não numérico e alocação vazia", () => {
    expect(ok(StrategyPlanSchema, plan)).toBe(true);
    expect(
      ok(StrategyPlanSchema, {
        ...plan,
        targetAllocation: [{ assetClass: "renda fixa", pct: "60" }],
      }),
    ).toBe(false);
    expect(ok(StrategyPlanSchema, { ...plan, targetAllocation: [] })).toBe(false);
  });

  it("StrategyPlan recusa successProbability 1.5 e byYear 1999", () => {
    const m = milestone;
    expect(
      ok(StrategyPlanSchema, { ...plan, milestones: [{ ...m, successProbability: 1.5 }] }),
    ).toBe(false);
    expect(ok(StrategyPlanSchema, { ...plan, milestones: [{ ...m, byYear: 1999 }] })).toBe(false);
  });

  it("TaxAdvice exige Money em estimatedTaxBrl e consultAccountant boolean", () => {
    const tax = {
      estimatedTaxBrl: "1200.00",
      harvestingOpportunities: [],
      offshoreVsBr: "comparação",
      actions: ["compensar perdas"],
      consultAccountant: true,
      narrative: "texto",
    };
    expect(ok(TaxAdviceSchema, tax)).toBe(true);
    expect(ok(TaxAdviceSchema, { ...tax, estimatedTaxBrl: 1200 })).toBe(false);
    expect(ok(TaxAdviceSchema, { ...tax, consultAccountant: "sim" })).toBe(false);
  });

  it("AssessorBrief exige de 1 a 5 perguntas", () => {
    const brief = { questions: ["q1"], sharedData: ["carteira"], narrative: "texto" };
    expect(ok(AssessorBriefSchema, brief)).toBe(true);
    expect(ok(AssessorBriefSchema, { ...brief, questions: [] })).toBe(false);
    expect(ok(AssessorBriefSchema, { ...brief, questions: ["a", "b", "c", "d", "e", "f"] })).toBe(
      false,
    );
  });
});
