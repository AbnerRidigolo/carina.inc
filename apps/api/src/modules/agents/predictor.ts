import { type CashFlowForecast, CashFlowForecastSchema } from "@carina/shared";
import type { ModelFactory } from "../llm/model-factory.js";
import { type AgentLogger, LlmAgent } from "./agent.js";
import { PROMPTS } from "./prompts.js";

/** Predictor: projeção de fluxo de caixa (12 a 36 meses), saída validada por Zod. */
export const createPredictor = (
  models: ModelFactory,
  logger: AgentLogger,
): LlmAgent<CashFlowForecast> =>
  new LlmAgent<CashFlowForecast>(models, logger, {
    name: "predictor",
    role: "reasoning",
    prompt: PROMPTS.predictor,
    schema: CashFlowForecastSchema,
  });
