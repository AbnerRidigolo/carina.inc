import { Inject, Logger, Module, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { ENV } from "../../core/config/config.module.js";
import type { Env } from "../../core/config/env.js";
import { AgentsModule } from "../agents/agents.module.js";
import { InboxModule } from "../inbox/inbox.module.js";
import { KnowledgeModule } from "../knowledge/knowledge.module.js";
import { LlmModule } from "../llm/llm.module.js";
import { MockResponderRegistry } from "../llm/mock-models.js";
import { createCheckpointer } from "./checkpointer.js";
import { classifierMockResponder } from "./heuristic.js";
import { ORCHESTRATOR_CHECKPOINTER, OrchestratorService } from "./orchestrator.service.js";
import { ResumeWorker, resumeLoggerProvider } from "./resume.worker.js";

/** Registra (idempotente) o responder do classificador no modo mock. */
export function registerOrchestratorMockResponders(registry: MockResponderRegistry): void {
  if (!registry.has("classifier")) registry.register("classifier", classifierMockResponder);
}

const checkpointerProvider = {
  provide: ORCHESTRATOR_CHECKPOINTER,
  inject: [ENV],
  useFactory: async (env: Pick<Env, "DATABASE_URL">): Promise<BaseCheckpointSaver> => {
    const saver = createCheckpointer(env, new Logger("Checkpointer"));
    try {
      await saver.setup(); // só confere a migração (ver checkpointer.ts)
    } catch (err) {
      await saver.end().catch(() => undefined);
      throw err;
    }
    return saver;
  },
};

/**
 * Orquestrador (grafo LangGraph). Módulo de serviço, sem rotas (por isso não importa o
 * TenancyModule/LimitsModule diretamente; o InboxModule já os traz na ordem certa): o ChatService
 * (Task 20) usa `stream`, e o ResumeWorker (consumidor de `resume` em `jobs`, grupo `resumers`)
 * usa `resume`; ele liga só com WORKERS_ENABLED !== "false" e para no onModuleDestroy dos
 * providers, que o Nest chama ANTES do onModuleDestroy deste módulo (que fecha o checkpointer).
 * O checkpointer é o PostgresSaver no schema `langgraph` (pool próprio, fechado no shutdown);
 * testes de unidade injetam MemorySaver.
 */
@Module({
  imports: [LlmModule, AgentsModule, KnowledgeModule, InboxModule],
  providers: [checkpointerProvider, OrchestratorService, ResumeWorker, resumeLoggerProvider],
  exports: [OrchestratorService, ResumeWorker],
})
export class OrchestratorModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(MockResponderRegistry) private readonly mocks: MockResponderRegistry,
    @Inject(ORCHESTRATOR_CHECKPOINTER) private readonly checkpointer: BaseCheckpointSaver,
  ) {}

  onModuleInit(): void {
    registerOrchestratorMockResponders(this.mocks);
  }

  async onModuleDestroy(): Promise<void> {
    const end = (this.checkpointer as { end?: () => Promise<void> }).end;
    if (typeof end === "function") await end.call(this.checkpointer);
  }
}
