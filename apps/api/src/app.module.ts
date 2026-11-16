import { type DynamicModule, Module } from "@nestjs/common";
import { ConfigModule } from "./core/config/config.module.js";
import { LoggingModule, type LoggingOptions } from "./core/logging/logging.module.js";
import { RedisModule } from "./core/redis/redis.module.js";
import { AgentsModule } from "./modules/agents/agents.module.js";
import { BillingModule } from "./modules/billing/billing.module.js";
import { ChatModule } from "./modules/chat/chat.module.js";
import { DataIngestionModule } from "./modules/data-ingestion/data-ingestion.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { InboxModule } from "./modules/inbox/inbox.module.js";
import { KnowledgeModule } from "./modules/knowledge/knowledge.module.js";
import { LimitsModule } from "./modules/limits/limits.module.js";
import { LlmModule } from "./modules/llm/llm.module.js";
import { MarketModule } from "./modules/market/market.module.js";
import { OrchestratorModule } from "./modules/orchestrator/orchestrator.module.js";
import { TenancyModule } from "./modules/tenancy/tenancy.module.js";
import { WatchtowerModule } from "./modules/watchtower/watchtower.module.js";

export interface AppModuleOptions {
  /** Destino dos logs (padrão: stdout); os testes do bootstrap passam um stream em memória. */
  logDestination?: LoggingOptions["destination"];
}

/**
 * Módulo raiz do processo HTTP (main.ts): rotas REST, gateway WebSocket, health e — com
 * WORKERS_ENABLED !== "false" — também os workers de fundo (SyncWorker, ResumeWorker,
 * ReconciliationJob), para rodar tudo num processo só em desenvolvimento.
 *
 * Ordem dos imports: TenancyModule ANTES do LimitsModule. Os guards globais rodam na ordem de
 * registro, e o RateLimitGuard precisa de `req.tenant` já preenchido pelo ApiKeyGuard (ver
 * billing.module.ts; cada módulo com rotas também importa os dois nessa ordem). Depois, os
 * módulos de domínio e o ChatModule (que traz o InboxBroadcast, um tail de `inbox.events` por
 * processo HTTP, e o ChatGateway).
 */
@Module({})
export class AppModule {
  static register(opts: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule,
        LoggingModule.forRoot(opts.logDestination ? { destination: opts.logDestination } : {}),
        RedisModule,
        TenancyModule,
        LimitsModule,
        BillingModule,
        WatchtowerModule,
        DataIngestionModule,
        MarketModule,
        KnowledgeModule,
        LlmModule,
        AgentsModule,
        InboxModule,
        OrchestratorModule,
        ChatModule,
        HealthModule,
      ],
    };
  }
}
