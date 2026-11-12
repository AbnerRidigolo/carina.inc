import type { ModelFactory } from "../llm/model-factory.js";
import { type AgentInput, type AgentLogger, LlmAgent } from "./agent.js";
import { PROMPTS, SYNTHESIZE_PROMPT } from "./prompts.js";

/**
 * Navigator, com dois modos:
 * - `answer`: caminho simples, responde direto (mockKey `navigator`);
 * - `synthesize`: junta os resultados dos especialistas, com o prompt extra que exige citar as
 *   análises que falharam e o disclaimer (mockKey `synthesize`).
 * `run` escolhe o modo: com `results` sintetiza, sem eles responde.
 */
export class NavigatorAgent extends LlmAgent<string> {
  constructor(models: ModelFactory, logger: AgentLogger) {
    super(models, logger, { name: "navigator", role: "conversational", prompt: PROMPTS.navigator });
  }

  answer(input: AgentInput): Promise<string> {
    return this.invoke(this.prompt, "navigator", {
      ...input,
      results: undefined,
    }) as Promise<string>;
  }

  synthesize(input: AgentInput & { results: Record<string, unknown> }): Promise<string> {
    return this.invoke(SYNTHESIZE_PROMPT, "synthesize", input) as Promise<string>;
  }

  override run(input: AgentInput): Promise<string> {
    return input.results
      ? this.synthesize({ ...input, results: input.results })
      : this.answer(input);
  }
}
