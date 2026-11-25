import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { AgentsModule } from "../agents/agents.module.js";
import { BillingCoreModule } from "../billing/billing-core.module.js";
import { KnowledgeModule } from "../knowledge/knowledge.module.js";
import { LimitsCoreModule } from "../limits/limits-core.module.js";
import { WatchtowerCoreModule } from "../watchtower/watchtower-core.module.js";
import { AopRunner, aopLoggerProvider } from "./aop-runner.js";
import { AopJob } from "./aop.job.js";
import { AopsRepository } from "./aops.repository.js";

/**
 * AOPs sem rotas nem guards globais: o AopsRepository (tabelas aop e aop_run, sob RLS por tenant, e
 * `aop_tenant_ids()`), o AopRunner (execução por cliente: agentes, cota, cobrança e Watchtower) e o
 * AopJob (agenda a cada `AOP_TICK_MS` com lock global `aops:tick` e consumidor de
 * `aop.run_requested` no grupo `aops` do stream `jobs`, ligados só com WORKERS_ENABLED !==
 * "false"). Usado pelo WorkerModule. StreamsService e LockService vêm do RedisModule global; CLOCK e
 * QuotaService, do LimitsCoreModule; o AgentRegistry (e o LlmModule), do AgentsModule.
 */
@Module({
  imports: [
    DatabaseModule,
    AgentsModule,
    KnowledgeModule,
    LimitsCoreModule,
    BillingCoreModule,
    WatchtowerCoreModule,
  ],
  providers: [AopsRepository, AopRunner, AopJob, aopLoggerProvider],
  exports: [AopsRepository, AopRunner, AopJob],
})
export class AopsCoreModule {}
