import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { TenancyCoreModule } from "../tenancy/tenancy-core.module.js";
import { ImportsRepository } from "./imports.repository.js";
import { ImportsService, importsLoggerProvider } from "./imports.service.js";

/**
 * Importação de arquivos sem rotas nem guards globais: ImportsService e ImportsRepository (o
 * worker da Task 10 também mora aqui). O StreamsService vem do RedisModule global.
 */
@Module({
  imports: [DatabaseModule, TenancyCoreModule],
  providers: [ImportsRepository, ImportsService, importsLoggerProvider],
  exports: [ImportsService, ImportsRepository],
})
export class ImportsCoreModule {}
