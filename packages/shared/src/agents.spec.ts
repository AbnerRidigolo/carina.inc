import { describe, expect, it } from "vitest";
import {
  ActionProposalSchema,
  AgentNameSchema,
  CashFlowForecastSchema,
  CashFlowScenarioSchema,
  PlanSchema,
  RiskAssessmentSchema,
  SpecialistNameSchema,
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
