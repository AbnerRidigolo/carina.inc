import { type AssessorBrief, AssessorBriefSchema } from "@carina/shared";
import type { ModelFactory } from "../llm/model-factory.js";
import { type AgentLogger, LlmAgent } from "./agent.js";
import { refineAssessorBrief } from "./output-limits.js";
import { PROMPTS } from "./prompts.js";

/** Assessor Liaison: redige perguntas ao assessor humano; nada é enviado. */
export const createAssessorLiaison = (
  models: ModelFactory,
  logger: AgentLogger,
): LlmAgent<AssessorBrief> =>
  new LlmAgent<AssessorBrief>(models, logger, {
    name: "assessor_liaison",
    role: "conversational",
    prompt: PROMPTS.assessor_liaison,
    schema: AssessorBriefSchema,
    refine: refineAssessorBrief,
  });
