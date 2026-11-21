import type { ModelFactory } from "../llm/model-factory.js";
import { type AgentLogger, LlmAgent } from "./agent.js";
import { PROMPTS } from "./prompts.js";

/** Researcher: responde só com a base de conhecimento do cliente (sem web), citando fontes. */
export const createResearcher = (models: ModelFactory, logger: AgentLogger): LlmAgent<string> =>
  new LlmAgent<string>(models, logger, {
    name: "researcher",
    role: "conversational",
    prompt: PROMPTS.researcher,
  });
