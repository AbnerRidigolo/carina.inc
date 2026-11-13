import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { InboxCoreModule } from "../inbox/inbox-core.module.js";
import { LlmModule } from "../llm/llm.module.js";
import { MockResponderRegistry } from "../llm/mock-models.js";
import { AgentRegistry } from "./agent-registry.js";
import { registerAgentMockResponders } from "./mock-responders.js";

/**
 * Agentes (navigator, insight, predictor, risk, executor). Módulo de serviço, sem rotas: o grafo de
 * chat (Task 19) consome o `AgentRegistry`. O Executor só propõe, via `InboxService.request`
 * (InboxCoreModule). Os responders do modo mock entram no registry do LlmModule ao subir.
 */
@Module({
  imports: [LlmModule, InboxCoreModule],
  providers: [AgentRegistry],
  exports: [AgentRegistry],
})
export class AgentsModule implements OnModuleInit {
  constructor(@Inject(MockResponderRegistry) private readonly mocks: MockResponderRegistry) {}

  onModuleInit(): void {
    registerAgentMockResponders(this.mocks);
  }
}
