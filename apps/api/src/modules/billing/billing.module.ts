import { Module } from "@nestjs/common";
import { LimitsModule } from "../limits/limits.module.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { BillingController } from "./billing.controller.js";
import { BillingCoreModule } from "./billing-core.module.js";

/**
 * Billing por resolução (rotas). Importa o TenancyModule antes do LimitsModule (que traz o
 * RateLimitGuard global) para que a ordem dos guards globais fique correta, qualquer que seja a
 * ordem em que o módulo raiz importe este. O serviço vem do BillingCoreModule (reexportado).
 */
@Module({
  imports: [TenancyModule, LimitsModule, BillingCoreModule],
  controllers: [BillingController],
  exports: [BillingCoreModule],
})
export class BillingModule {}
