import { Controller, Get, Inject, Param } from "@nestjs/common";
import { TenantContext } from "../../core/context/tenant-context.js";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import { ClientsService } from "./clients.service.js";
import { RequireScopes } from "./scopes.decorator.js";

@Controller("clients")
export class ClientsController {
  constructor(
    @Inject(ClientsService) private readonly clients: ClientsService,
    @Inject(TenantPrismaService) private readonly db: TenantPrismaService,
  ) {}

  /** Clientes do tenant da chave. */
  @Get()
  @RequireScopes("chat")
  list() {
    return this.clients.list();
  }

  /**
   * Posições do cliente. Cliente inexistente ou de outro tenant → 404 (o RLS o esconde).
   * Versão mínima: a Task 13 completa esta rota.
   */
  @Get(":clientId/positions")
  @RequireScopes("chat")
  async positions(@Param("clientId") externalId: string) {
    const client = await this.clients.resolve(externalId);
    return TenantContext.withClient(client.id, () =>
      this.db.client.position.findMany({
        where: { clientId: client.id },
        orderBy: [{ assetClass: "asc" }, { name: "asc" }, { externalId: "asc" }],
      }),
    );
  }
}
