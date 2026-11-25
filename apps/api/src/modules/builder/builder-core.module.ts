import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { StrategyRepository } from "./strategy.repository.js";

/**
 * Builder de estratégias sem rotas nem guards globais: o StrategyRepository (tabela strategy, sob
 * RLS por tenant). O DatabaseModule entra para quem importar este módulo abrir a `tx` com o
 * TenantPrismaService. As rotas (e o backtest com mercado e cobrança) vêm em outro módulo.
 */
@Module({
  imports: [DatabaseModule],
  providers: [StrategyRepository],
  exports: [StrategyRepository],
})
export class BuilderCoreModule {}
