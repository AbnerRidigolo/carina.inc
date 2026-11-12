import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { AgentName } from "@carina/shared";
import { ValidationError } from "../../core/errors/domain-errors.js";
import { InboxService } from "../inbox/inbox.service.js";
import { ModelFactory } from "../llm/model-factory.js";
import type { AgentDef, AgentLogger } from "./agent.js";
import { ExecutorAgent } from "./executor.js";
import { createInsight } from "./insight.js";
import { NavigatorAgent } from "./navigator.js";
import { createPredictor } from "./predictor.js";
import { createRisk } from "./risk.js";

export const AGENTS_LOGGER = Symbol("AGENTS_LOGGER");

@Injectable()
export class AgentRegistry {
  private readonly agents: Record<AgentName, AgentDef<unknown>>;
  private readonly navigatorAgent: NavigatorAgent;
  private readonly executorAgent: ExecutorAgent;

  constructor(
    @Inject(ModelFactory) models: ModelFactory,
    @Inject(InboxService) inbox: InboxService,
    @Optional() @Inject(AGENTS_LOGGER) logger: AgentLogger = new Logger("Agents"),
  ) {
    this.navigatorAgent = new NavigatorAgent(models, logger);
    this.executorAgent = new ExecutorAgent(models, logger, inbox);
    this.agents = {
      navigator: this.navigatorAgent,
      insight: createInsight(models, logger),
      predictor: createPredictor(models, logger),
      risk: createRisk(models, logger),
      executor: this.executorAgent,
    };
  }

  get(name: AgentName): AgentDef<unknown> {
    const agent = Object.hasOwn(this.agents, name) ? this.agents[name] : undefined;
    if (!agent) throw new ValidationError("Agente desconhecido");
    return agent;
  }

  navigator(): NavigatorAgent {
    return this.navigatorAgent;
  }

  executor(): ExecutorAgent {
    return this.executorAgent;
  }
}
