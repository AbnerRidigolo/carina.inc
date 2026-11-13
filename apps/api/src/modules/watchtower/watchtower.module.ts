import { Module } from "@nestjs/common";
import { LimitsModule } from "../limits/limits.module.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { WatchtowerController } from "./watchtower.controller.js";
import { WatchtowerCoreModule } from "./watchtower-core.module.js";

/**
 * Watchtower (compliance e trilha de auditoria), com rotas. Importa o TenancyModule antes do
 * LimitsModule (que traz o RateLimitGuard global) para que a ordem dos guards globais fique
 * correta (ApiKeyGuard → RateLimitGuard), qualquer que seja a ordem em que o módulo raiz importe
 * este. O serviço vem do WatchtowerCoreModule (reexportado).
 */
@Module({
  imports: [TenancyModule, LimitsModule, WatchtowerCoreModule],
  controllers: [WatchtowerController],
  exports: [WatchtowerCoreModule],
})
export class WatchtowerModule {}
