import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { LimitsModule } from "../limits/limits.module.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { BillingController } from "./billing.controller.js";
import { BillingService } from "./billing.service.js";

/**
 * Billing por resolução. Importa o TenancyModule antes do LimitsModule (que traz o CLOCK e o
 * RateLimitGuard global) para que a ordem dos guards globais fique correta, qualquer que seja a
 * ordem em que o módulo raiz importe este.
 */
@Module({
  imports: [DatabaseModule, TenancyModule, LimitsModule],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
