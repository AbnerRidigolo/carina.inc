import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { BillingModule } from "../billing/billing.module.js";
import { LimitsModule } from "../limits/limits.module.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { IngestionController } from "./ingestion.controller.js";
import { IngestionRepository } from "./ingestion.repository.js";
import { IngestionService, ingestionLoggerProvider } from "./ingestion.service.js";

/**
 * Ingestão de dados do cliente final (posições e transações). Expõe rotas, então importa o
 * TenancyModule antes do LimitsModule (que traz o CLOCK e o RateLimitGuard global) para que a ordem
 * dos guards globais fique correta (ApiKeyGuard → RateLimitGuard), qualquer que seja a ordem em que
 * o módulo raiz importe este. O StreamsService vem do RedisModule global (via LimitsModule).
 */
@Module({
  imports: [DatabaseModule, TenancyModule, LimitsModule, BillingModule],
  controllers: [IngestionController],
  providers: [IngestionRepository, IngestionService, ingestionLoggerProvider],
  exports: [IngestionService],
})
export class DataIngestionModule {}
