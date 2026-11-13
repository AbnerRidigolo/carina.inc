import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { BillingCoreModule } from "../billing/billing-core.module.js";
import { LimitsCoreModule } from "../limits/limits-core.module.js";
import { TenancyCoreModule } from "../tenancy/tenancy-core.module.js";
import { WatchtowerCoreModule } from "../watchtower/watchtower-core.module.js";
import { ExecutorRegistry } from "./executors.js";
import { InboxService, inboxLoggerProvider } from "./inbox.service.js";
import { ReconciliationJob } from "./reconciliation.job.js";

/**
 * Inbox sem rotas nem guards globais: InboxService, executores e a ReconciliationJob (que liga só
 * com WORKERS_ENABLED !== "false"). Usado pelo orquestrador, pelos agentes e pelo WorkerModule.
 * StreamsService e LockService vêm do RedisModule global; o CLOCK, do LimitsCoreModule.
 */
@Module({
  imports: [
    DatabaseModule,
    TenancyCoreModule,
    LimitsCoreModule,
    BillingCoreModule,
    WatchtowerCoreModule,
  ],
  providers: [ExecutorRegistry, InboxService, inboxLoggerProvider, ReconciliationJob],
  exports: [InboxService, ExecutorRegistry, ReconciliationJob],
})
export class InboxCoreModule {}
