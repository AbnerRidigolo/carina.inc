import { Controller, Get, Inject } from "@nestjs/common";
import { ClientsService } from "./clients.service.js";
import { RequireScopes } from "./scopes.decorator.js";

/**
 * Clientes do tenant. As rotas `/clients/:clientId/positions` e `/transactions` (leitura e
 * ingestão) vivem no `IngestionController` do módulo data-ingestion: este módulo não pode depender
 * dele (o data-ingestion é que importa o tenancy).
 */
@Controller("clients")
export class ClientsController {
  constructor(@Inject(ClientsService) private readonly clients: ClientsService) {}

  /** Clientes do tenant da chave. */
  @Get()
  @RequireScopes("chat")
  list() {
    return this.clients.list();
  }
}
