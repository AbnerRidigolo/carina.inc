import { Module } from "@nestjs/common";
import { LimitsModule } from "../limits/limits.module.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { DataIngestionCoreModule } from "./data-ingestion-core.module.js";
import { IngestionController } from "./ingestion.controller.js";

/**
 * Ingestão de dados do cliente final (posições e transações), com rotas. Importa o TenancyModule
 * antes do LimitsModule (que traz o RateLimitGuard global) para que a ordem dos guards globais
 * fique correta (ApiKeyGuard → RateLimitGuard), qualquer que seja a ordem em que o módulo raiz
 * importe este. IngestionService e SyncWorker vêm do DataIngestionCoreModule (reexportado).
 */
@Module({
  imports: [TenancyModule, LimitsModule, DataIngestionCoreModule],
  controllers: [IngestionController],
  exports: [DataIngestionCoreModule],
})
export class DataIngestionModule {}
