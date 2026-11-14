import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { ClientsService } from "./clients.service.js";
import { LiveKeyService } from "./live-key.service.js";

/**
 * Serviços do tenancy SEM rotas e sem guards globais (ClientsService, LiveKeyService). É o que os
 * módulos de serviço e o WorkerModule (processo sem HTTP) importam; o TenancyModule acrescenta o
 * controller e os guards/interceptor globais do processo HTTP.
 */
@Module({
  imports: [DatabaseModule],
  providers: [ClientsService, LiveKeyService],
  exports: [ClientsService, LiveKeyService],
})
export class TenancyCoreModule {}
