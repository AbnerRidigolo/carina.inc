import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { DataIngestionCoreModule } from "../data-ingestion/data-ingestion-core.module.js";
import { LimitsCoreModule } from "../limits/limits-core.module.js";
import { TenancyCoreModule } from "../tenancy/tenancy-core.module.js";
import { ImportCleanupJob } from "./import-cleanup.job.js";
import { ImportWorker, importLoggerProvider } from "./import.worker.js";
import { ImportsRepository } from "./imports.repository.js";
import { ImportsService, importsLoggerProvider } from "./imports.service.js";

/**
 * Importação de arquivos sem rotas nem guards globais: ImportsService, ImportsRepository, o
 * ImportWorker (grupo `imports` do stream `jobs`) e a ImportCleanupJob (timer), os dois ligados
 * só com WORKERS_ENABLED !== "false". Usado pelo ImportsModule e pelo WorkerModule.
 * StreamsService e LockService vêm do RedisModule global; o CLOCK, do LimitsCoreModule; o
 * IngestionService, do DataIngestionCoreModule.
 */
@Module({
  imports: [DatabaseModule, TenancyCoreModule, DataIngestionCoreModule, LimitsCoreModule],
  providers: [
    ImportsRepository,
    ImportsService,
    importsLoggerProvider,
    ImportWorker,
    importLoggerProvider,
    ImportCleanupJob,
  ],
  exports: [ImportsService, ImportsRepository, ImportWorker, ImportCleanupJob],
})
export class ImportsCoreModule {}
