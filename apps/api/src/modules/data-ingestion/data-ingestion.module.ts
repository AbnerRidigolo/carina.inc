import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { BillingModule } from "../billing/billing.module.js";
import { KnowledgeModule } from "../knowledge/knowledge.module.js";
import { LimitsModule } from "../limits/limits.module.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { IngestionController } from "./ingestion.controller.js";
import { IngestionRepository } from "./ingestion.repository.js";
import { IngestionService, ingestionLoggerProvider } from "./ingestion.service.js";
import { SyncWorker, syncLoggerProvider } from "./sync.worker.js";

/**
 * Ingestão de dados do cliente final (posições e transações). Expõe rotas, então importa o
 * TenancyModule antes do LimitsModule (que traz o CLOCK e o RateLimitGuard global) para que a ordem
 * dos guards globais fique correta (ApiKeyGuard → RateLimitGuard), qualquer que seja a ordem em que
 * o módulo raiz importe este. O StreamsService vem do RedisModule global (via LimitsModule).
 *
 * Também roda o worker de Sync (sem rotas): consome `data.ingested` em `jobs` e escreve no
 * conhecimento (KnowledgeModule), se WORKERS_ENABLED !== "false".
 */
@Module({
  imports: [DatabaseModule, TenancyModule, LimitsModule, BillingModule, KnowledgeModule],
  controllers: [IngestionController],
  providers: [
    IngestionRepository,
    IngestionService,
    ingestionLoggerProvider,
    SyncWorker,
    syncLoggerProvider,
  ],
  exports: [IngestionService, SyncWorker],
})
export class DataIngestionModule {}
