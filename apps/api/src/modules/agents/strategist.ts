import { type StrategyPlan, StrategyPlanSchema } from "@carina/shared";
import type { ModelFactory } from "../llm/model-factory.js";
import { type AgentLogger, LlmAgent } from "./agent.js";
import { refineStrategy } from "./output-limits.js";
import { PROMPTS } from "./prompts.js";

/** Strategist: plano estratégico de longo prazo (alocação alvo e marcos). Só propõe. */
export const createStrategist = (
  models: ModelFactory,
  logger: AgentLogger,
): LlmAgent<StrategyPlan> =>
  new LlmAgent<StrategyPlan>(models, logger, {
    name: "strategist",
    role: "reasoning",
    prompt: PROMPTS.strategist,
    schema: StrategyPlanSchema,
    refine: refineStrategy,
  });
