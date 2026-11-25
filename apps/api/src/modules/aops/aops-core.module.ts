import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { AopsRepository } from "./aops.repository.js";

/**
 * AOPs sem rotas nem guards globais: o AopsRepository (tabelas aop e aop_run, sob RLS por tenant, e
 * `aop_tenant_ids()`). O DatabaseModule entra para quem importar este módulo abrir a `tx` com o
 * TenantPrismaService. As rotas e o job vêm em outros módulos.
 */
@Module({
  imports: [DatabaseModule],
  providers: [AopsRepository],
  exports: [AopsRepository],
})
export class AopsCoreModule {}
