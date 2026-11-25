import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { BillingCoreModule } from "../billing/billing-core.module.js";
import { LimitsModule } from "../limits/limits.module.js";
import { MarketCoreModule } from "../market/market-core.module.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { BuilderCoreModule } from "./builder-core.module.js";
import { BuilderController } from "./builder.controller.js";

/**
 * Rotas das estratégias e do backtest. Importa o TenancyModule antes do LimitsModule (ordem dos
 * guards globais, ver billing.module.ts); o histórico vem do MarketCoreModule (sem rotas nem
 * guards próprios) e o repositório do BuilderCoreModule.
 */
@Module({
  imports: [
    TenancyModule,
    LimitsModule,
    BillingCoreModule,
    DatabaseModule,
    MarketCoreModule,
    BuilderCoreModule,
  ],
  controllers: [BuilderController],
})
export class BuilderModule {}
