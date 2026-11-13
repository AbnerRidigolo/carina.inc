import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { LimitsCoreModule } from "../limits/limits-core.module.js";
import { BillingService } from "./billing.service.js";

/** BillingService sem rotas nem guards globais (módulos de serviço e WorkerModule). */
@Module({
  imports: [DatabaseModule, LimitsCoreModule],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingCoreModule {}
