import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { BillingCoreModule } from "../billing/billing-core.module.js";
import { KnowledgeModule } from "../knowledge/knowledge.module.js";
import { TenancyCoreModule } from "../tenancy/tenancy-core.module.js";
import { IngestionRepository } from "./ingestion.repository.js";
import { IngestionService, ingestionLoggerProvider } from "./ingestion.service.js";
import { SyncWorker, syncLoggerProvider } from "./sync.worker.js";

/**
 * Ingestão sem rotas nem guards globais: IngestionService e o worker de Sync (consome
 * `data.ingested` em `jobs` e escreve no conhecimento, se WORKERS_ENABLED !== "false"). Usado
 * pelo WorkerModule e pelo seed. O StreamsService vem do RedisModule global.
 */
@Module({
  imports: [DatabaseModule, TenancyCoreModule, BillingCoreModule, KnowledgeModule],
  providers: [
    IngestionRepository,
    IngestionService,
    ingestionLoggerProvider,
    SyncWorker,
    syncLoggerProvider,
  ],
  exports: [IngestionService, SyncWorker],
})
export class DataIngestionCoreModule {}
