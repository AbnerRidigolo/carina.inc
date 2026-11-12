import { type RiskAssessment, RiskAssessmentSchema } from "@carina/shared";
import type { ModelFactory } from "../llm/model-factory.js";
import { type AgentLogger, LlmAgent } from "./agent.js";
import { PROMPTS } from "./prompts.js";

/** Risk (Rebalancer + Risk Manager): drift, VaR, correlações e sugestões. Só propõe. */
export const createRisk = (models: ModelFactory, logger: AgentLogger): LlmAgent<RiskAssessment> =>
  new LlmAgent<RiskAssessment>(models, logger, {
    name: "risk",
    role: "reasoning",
    prompt: PROMPTS.risk,
    schema: RiskAssessmentSchema,
  });
