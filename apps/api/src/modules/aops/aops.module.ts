import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { LimitsModule } from "../limits/limits.module.js";
import { LlmModule } from "../llm/llm.module.js";
import { MockResponderRegistry } from "../llm/mock-models.js";
import { TenancyModule } from "../tenancy/tenancy.module.js";
import { AopsController } from "./aops.controller.js";
import { AopsCoreModule } from "./aops-core.module.js";
import { AopCompiler, registerAopMockResponders } from "./compiler.js";

/**
 * Rotas dos AOPs. Importa o TenancyModule antes do LimitsModule (ordem dos guards globais, ver
 * billing.module.ts). O AopsCoreModule traz o repositório, a execução e o AopJob (que só liga com
 * WORKERS_ENABLED !== "false", como o MonitorJob no MonitorModule). O compilador mora aqui (só a
 * rota o usa) e o responder do modo mock entra no registry do LlmModule ao subir, como o do
 * classificador.
 */
@Module({
  imports: [TenancyModule, LimitsModule, DatabaseModule, LlmModule, AopsCoreModule],
  controllers: [AopsController],
  providers: [AopCompiler],
  exports: [AopsCoreModule],
})
export class AopsModule implements OnModuleInit {
  constructor(@Inject(MockResponderRegistry) private readonly mocks: MockResponderRegistry) {}

  onModuleInit(): void {
    registerAopMockResponders(this.mocks);
  }
}
