import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { DatabaseModule } from "../../core/database/database.module.js";
import { ApiKeyGuard, TenantContextInterceptor } from "./api-key.guard.js";
import { ClientsController } from "./clients.controller.js";
import { TenancyCoreModule } from "./tenancy-core.module.js";

/**
 * Registra o ApiKeyGuard e o TenantContextInterceptor como globais: toda rota HTTP exige chave,
 * exceto as marcadas com @Public(). Guards globais de outros módulos (ex.: rate limit) devem ser
 * registrados depois deste módulo, para rodarem com `req.tenant` já preenchido. Os serviços vêm
 * do TenancyCoreModule (reexportado).
 */
@Module({
  imports: [DatabaseModule, TenancyCoreModule],
  controllers: [ClientsController],
  providers: [
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
  exports: [TenancyCoreModule],
})
export class TenancyModule {}
