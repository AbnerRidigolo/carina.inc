import { Module } from "@nestjs/common";
import { LimitsModule } from "../limits/limits.module.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { InboxController } from "./inbox.controller.js";
import { InboxCoreModule } from "./inbox-core.module.js";

/**
 * Inbox de aprovações (rotas). Importa o TenancyModule antes do LimitsModule (que traz o
 * RateLimitGuard global) para a ordem dos guards globais ficar correta (ApiKeyGuard →
 * RateLimitGuard), qualquer que seja a ordem em que o módulo raiz importe este. Serviços e
 * ReconciliationJob vêm do InboxCoreModule (reexportado).
 */
@Module({
  imports: [TenancyModule, LimitsModule, InboxCoreModule],
  controllers: [InboxController],
  exports: [InboxCoreModule],
})
export class InboxModule {}
