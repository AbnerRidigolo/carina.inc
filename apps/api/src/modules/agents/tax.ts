import { type TaxAdvice, TaxAdviceSchema } from "@carina/shared";
import type { ModelFactory } from "../llm/model-factory.js";
import { type AgentLogger, LlmAgent } from "./agent.js";
import { refineTax } from "./output-limits.js";
import { PROMPTS } from "./prompts.js";

/** Tax: estimativa de IR, compensação de prejuízos e offshore vs. Brasil. Só propõe. */
export const createTax = (models: ModelFactory, logger: AgentLogger): LlmAgent<TaxAdvice> =>
  new LlmAgent<TaxAdvice>(models, logger, {
    name: "tax",
    role: "reasoning",
    prompt: PROMPTS.tax,
    schema: TaxAdviceSchema,
    refine: refineTax,
  });
