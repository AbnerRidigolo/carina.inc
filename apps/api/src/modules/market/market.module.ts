import { Module } from "@nestjs/common";
import { BillingCoreModule } from "../billing/billing-core.module.js";
import { LimitsModule } from "../limits/limits.module.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { MarketCoreModule } from "./market-core.module.js";
import { MarketController } from "./market.controller.js";

/**
 * Rotas de mercado. Importa o TenancyModule antes do LimitsModule (ordem dos guards globais, ver
 * billing.module.ts); o serviço vem do MarketCoreModule.
 */
@Module({
  imports: [TenancyModule, LimitsModule, BillingCoreModule, MarketCoreModule],
  controllers: [MarketController],
  exports: [MarketCoreModule],
})
export class MarketModule {}
