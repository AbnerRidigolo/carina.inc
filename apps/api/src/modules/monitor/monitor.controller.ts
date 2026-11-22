import type { PortfolioAlertPage } from "@carina/shared";
import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { ZodValidationPipe } from "nestjs-zod";
import { z } from "zod";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import { ClientsService } from "../tenancy/clients.service.js";
import { RequireScopes } from "../tenancy/scopes.decorator.js";
import { MonitorRepository } from "./monitor.repository.js";

export const DEFAULT_ALERTS_LIMIT = 20;
export const MAX_ALERTS_LIMIT = 50;

/** `?limit=` (1 a 50, padrão 20) e `?cursor=` (o `nextCursor` da página anterior). */
export const AlertsQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d{1,3}$/, "precisa ser um inteiro")
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_ALERTS_LIMIT))
    .default(DEFAULT_ALERTS_LIMIT),
  cursor: z.string().min(1).max(256).optional(),
});
type AlertsQuery = z.output<typeof AlertsQuerySchema>;

/**
 * Alertas de variação da carteira do cliente final (`:clientId` é o `externalId` do tenant).
 * Escopo `chat`; só leitura, sem cobrança. Cliente de outro tenant é indistinguível de inexistente
 * (404); cursor malformado vira 422 (ValidationError do repositório).
 */
@Controller("clients/:clientId/alerts")
export class MonitorController {
  constructor(
    @Inject(ClientsService) private readonly clients: ClientsService,
    @Inject(TenantPrismaService) private readonly db: TenantPrismaService,
    @Inject(MonitorRepository) private readonly repo: MonitorRepository,
  ) {}

  @Get()
  @RequireScopes("chat")
  async list(
    @Param("clientId") clientId: string,
    @Query(new ZodValidationPipe(AlertsQuerySchema)) query: AlertsQuery,
  ): Promise<PortfolioAlertPage> {
    const client = await this.clients.resolve(clientId);
    return this.db.tx((tx) => this.repo.list(tx, client.id, query.cursor ?? null, query.limit));
  }
}
