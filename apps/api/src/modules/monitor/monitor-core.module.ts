import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { MonitorRepository } from "./monitor.repository.js";

/**
 * Monitor de carteira sem rotas nem guards globais: por enquanto só o MonitorRepository (tabela
 * portfolio_alert e `monitor_tenant_ids()`). O job e a rota entram por cima dele.
 */
@Module({
  imports: [DatabaseModule],
  providers: [MonitorRepository],
  exports: [MonitorRepository],
})
export class MonitorCoreModule {}
