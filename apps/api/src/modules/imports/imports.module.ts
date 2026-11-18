import { Module } from "@nestjs/common";
import { LimitsModule } from "../limits/limits.module.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { ImportsController } from "./imports.controller.js";
import { ImportsCoreModule } from "./imports-core.module.js";

/**
 * Importação de arquivos com rotas. Importa o TenancyModule antes do LimitsModule (que traz o
 * RateLimitGuard global) para manter a ordem dos guards globais (ApiKeyGuard → RateLimitGuard).
 */
@Module({
  imports: [TenancyModule, LimitsModule, ImportsCoreModule],
  controllers: [ImportsController],
  exports: [ImportsCoreModule],
})
export class ImportsModule {}
