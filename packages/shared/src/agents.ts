import { z } from "zod";
import { MoneySchema } from "./money.js";

export const SpecialistNameSchema = z.enum(["insight", "predictor", "risk"]);
export type SpecialistName = z.infer<typeof SpecialistNameSchema>;

export const AgentNameSchema = z.enum(["insight", "predictor", "risk", "navigator", "executor"]);
export type AgentName = z.infer<typeof AgentNameSchema>;

export const PlanSchema = z.object({
  complexity: z.enum(["simples", "média", "complexa"]),
  agents: z.array(SpecialistNameSchema),
  wantsExecution: z.boolean(),
  rationale: z.string(),
});
export type Plan = z.infer<typeof PlanSchema>;

export const CashFlowScenarioSchema = z.object({
  name: z.string(),
  horizonMonths: z.number().int().min(12).max(36),
  assumptions: z.array(z.string()),
  projectedNetFlowBrl: MoneySchema,
  confidence: z.number().min(0).max(1),
});
export type CashFlowScenario = z.infer<typeof CashFlowScenarioSchema>;

export const CashFlowForecastSchema = z.object({
  scenarios: z.array(CashFlowScenarioSchema).min(1),
  narrative: z.string(),
});
export type CashFlowForecast = z.infer<typeof CashFlowForecastSchema>;

export const RiskAssessmentSchema = z.object({
  driftPct: z.number(),
  valueAtRiskBrl: MoneySchema,
  topCorrelations: z.array(z.string()),
  stressFindings: z.array(z.string()),
  rebalanceSuggestions: z.array(z.string()),
});
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

export const ActionProposalSchema = z.object({
  action: z.string(),
  payload: z.record(z.string(), z.unknown()),
  valueBrl: MoneySchema,
  rationale: z.string(),
});
export type ActionProposal = z.infer<typeof ActionProposalSchema>;
