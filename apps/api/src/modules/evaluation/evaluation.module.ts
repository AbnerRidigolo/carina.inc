import { Module } from "@nestjs/common";
import { BillingCoreModule } from "../billing/billing-core.module.js";
import { LimitsModule } from "../limits/limits.module.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { EvaluationController } from "./evaluation.controller.js";

/**
 * Rotas do benchmark SEAL BR. Importa o TenancyModule antes do LimitsModule (ordem dos guards
 * globais, ver billing.module.ts). O motor de correção é puro, sem provider.
 */
@Module({
  imports: [TenancyModule, LimitsModule, BillingCoreModule],
  controllers: [EvaluationController],
})
export class EvaluationModule {}
