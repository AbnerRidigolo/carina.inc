import type { ModelFactory } from "../llm/model-factory.js";
import { type AgentLogger, LlmAgent } from "./agent.js";
import { PROMPTS } from "./prompts.js";

/** Insight: composição do portfólio, concentração e anomalias (texto). */
export const createInsight = (models: ModelFactory, logger: AgentLogger): LlmAgent<string> =>
  new LlmAgent<string>(models, logger, {
    name: "insight",
    role: "conversational",
    prompt: PROMPTS.insight,
  });
