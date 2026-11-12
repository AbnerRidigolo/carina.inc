import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { BillingModule } from "../billing/billing.module.js";
import { LimitsModule } from "../limits/limits.module.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { WatchtowerModule } from "../watchtower/watchtower.module.js";
import { ExecutorRegistry } from "./executors.js";
import { InboxController } from "./inbox.controller.js";
import { InboxService, inboxLoggerProvider } from "./inbox.service.js";
import { ReconciliationJob } from "./reconciliation.job.js";

/**
 * Inbox de aprovações. Expõe rotas, então importa o TenancyModule antes do LimitsModule (que traz o
 * CLOCK e o RateLimitGuard global) para a ordem dos guards globais ficar correta (ApiKeyGuard →
 * RateLimitGuard), qualquer que seja a ordem em que o módulo raiz importe este. StreamsService e
 * LockService vêm do RedisModule global. A ReconciliationJob liga só com WORKERS_ENABLED !== "false".
 */
@Module({
  imports: [DatabaseModule, TenancyModule, LimitsModule, BillingModule, WatchtowerModule],
  controllers: [InboxController],
  providers: [ExecutorRegistry, InboxService, inboxLoggerProvider, ReconciliationJob],
  exports: [InboxService, ExecutorRegistry, ReconciliationJob],
})
export class InboxModule {}
