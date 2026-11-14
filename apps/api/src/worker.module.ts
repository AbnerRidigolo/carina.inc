import { Module } from "@nestjs/common";
import { ConfigModule } from "./core/config/config.module.js";
import { LoggingModule } from "./core/logging/logging.module.js";
import { RedisModule } from "./core/redis/redis.module.js";
import { DataIngestionCoreModule } from "./modules/data-ingestion/data-ingestion-core.module.js";
import { InboxCoreModule } from "./modules/inbox/inbox-core.module.js";
import { MarketCoreModule } from "./modules/market/market-core.module.js";
import { OrchestratorModule } from "./modules/orchestrator/orchestrator.module.js";

/**
 * Módulo raiz do processo de workers (main.worker.ts, sem HTTP): só os módulos de SERVIÇO de que
 * os workers precisam, sem controllers, sem guards globais, sem gateway e sem InboxBroadcast.
 *
 * - DataIngestionCoreModule → SyncWorker (grupo `sync` do stream `jobs`);
 * - OrchestratorModule → ResumeWorker (grupo `resumers` do stream `jobs`);
 * - MarketCoreModule → MarketService e provedores (por MARKET_MODE), sem rotas;
 * - InboxCoreModule → ReconciliationJob (timer; um lock Redis global por tick evita ticks simultâneos).
 */
@Module({
  imports: [
    ConfigModule,
    LoggingModule.forRoot(),
    RedisModule,
    DataIngestionCoreModule,
    InboxCoreModule,
    MarketCoreModule,
    OrchestratorModule,
  ],
})
export class WorkerModule {}
