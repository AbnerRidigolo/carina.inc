/**
 * Cliente Prisma bruto, conectado como carina_app (DATABASE_URL) pelo driver adapter do pg.
 *
 * NÃO use direto em código de domínio: sem `app.tenant_id` fixado, o RLS não devolve nenhuma
 * linha. Os únicos usos permitidos são `resolve_api_key` (autenticação, antes de existir tenant)
 * e o próprio TenantPrismaService, que fixa o contexto em cada transação.
 */
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import { ENV } from "../config/config.module.js";
import type { Env } from "../config/env.js";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Pick<Env, "DATABASE_URL">) {
    super({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
