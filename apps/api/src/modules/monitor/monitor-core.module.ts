import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { LimitsCoreModule } from "../limits/limits-core.module.js";
import { MarketCoreModule } from "../market/market-core.module.js";
import { MonitorJob, monitorLoggerProvider } from "./monitor.job.js";
import { MonitorRepository } from "./monitor.repository.js";

/**
 * Monitor de carteira sem rotas nem guards globais: o MonitorRepository (tabela portfolio_alert e
 * `monitor_tenant_ids()`) e o MonitorJob (timer de `MONITOR_INTERVAL_MS` com lock global
 * `monitor:tick`, ligado só com WORKERS_ENABLED !== "false"). Usado pelo WorkerModule.
 * StreamsService, LockService e REDIS vêm do RedisModule global; o CLOCK, do LimitsCoreModule; o
 * MarketService, do MarketCoreModule.
 */
@Module({
  imports: [DatabaseModule, LimitsCoreModule, MarketCoreModule],
  providers: [MonitorRepository, MonitorJob, monitorLoggerProvider],
  exports: [MonitorRepository, MonitorJob],
})
export class MonitorCoreModule {}
