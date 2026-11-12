import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { LimitsModule } from "../limits/limits.module.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { WatchtowerController } from "./watchtower.controller.js";
import { WatchtowerService } from "./watchtower.service.js";

/**
 * Watchtower (compliance e trilha de auditoria). Importa o TenancyModule antes do LimitsModule
 * (que traz o RateLimitGuard global) para que a ordem dos guards globais fique correta
 * (ApiKeyGuard → RateLimitGuard), qualquer que seja a ordem em que o módulo raiz importe este.
 */
@Module({
  imports: [DatabaseModule, TenancyModule, LimitsModule],
  controllers: [WatchtowerController],
  providers: [WatchtowerService],
  exports: [WatchtowerService],
})
export class WatchtowerModule {}
