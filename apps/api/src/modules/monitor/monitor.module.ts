import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { LimitsModule } from "../limits/limits.module.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { MonitorController } from "./monitor.controller.js";
import { MonitorCoreModule } from "./monitor-core.module.js";

/**
 * Monitor de carteira com a rota de leitura de alertas. Importa o TenancyModule antes do
 * LimitsModule (que traz o RateLimitGuard global) para manter a ordem dos guards globais
 * (ApiKeyGuard → RateLimitGuard). O MonitorJob vem junto com o MonitorCoreModule e só liga com
 * WORKERS_ENABLED !== "false", como a ImportCleanupJob no ImportsModule.
 */
@Module({
  imports: [DatabaseModule, TenancyModule, LimitsModule, MonitorCoreModule],
  controllers: [MonitorController],
  exports: [MonitorCoreModule],
})
export class MonitorModule {}
