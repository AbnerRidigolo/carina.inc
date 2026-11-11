import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { DatabaseModule } from "../../core/database/database.module.js";
import { ApiKeyGuard, TenantContextInterceptor } from "./api-key.guard.js";
import { ClientsController } from "./clients.controller.js";
import { ClientsService } from "./clients.service.js";

/**
 * Registra o ApiKeyGuard e o TenantContextInterceptor como globais: toda rota HTTP exige chave,
 * exceto as marcadas com @Public(). Guards globais de outros módulos (ex.: rate limit) devem ser
 * registrados depois deste módulo, para rodarem com `req.tenant` já preenchido.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [ClientsController],
  providers: [
    ClientsService,
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
  exports: [ClientsService],
})
export class TenancyModule {}
