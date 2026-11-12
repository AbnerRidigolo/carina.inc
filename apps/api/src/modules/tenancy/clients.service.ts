/**
 * Clientes finais do tenant, identificados pelo `externalId` que o tenant usa no sistema dele.
 *
 * Tudo roda sob RLS pelo TenantPrismaService, com o tenant do TenantContext atual: o cliente de
 * outro tenant é invisível e resolve como NotFoundError (404), exatamente como um inexistente.
 * O filtro explícito por `tenantId` é defesa em profundidade, não a barreira principal.
 */
import { Inject, Injectable } from "@nestjs/common";
import { TenantContext } from "../../core/context/tenant-context.js";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import { NotFoundError, ValidationError } from "../../core/errors/domain-errors.js";
import { Prisma } from "../../generated/prisma/client.js";

export interface ClientRef {
  id: string;
  externalId: string;
}

export interface ClientSummary extends ClientRef {
  createdAt: Date;
}

// 1..128 caracteres (como `externalId` nos contratos de ingestão), sem caracteres de controle,
// de formatação ou inválidos (\p{C}: NUL, quebras de linha, zero-width…).
const EXTERNAL_ID_RE = /^[^\p{C}]{1,128}$/u;

function assertExternalId(externalId: string): void {
  if (!EXTERNAL_ID_RE.test(externalId)) {
    throw new ValidationError(
      "clientId precisa ter de 1 a 128 caracteres, sem caracteres de controle",
    );
  }
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

@Injectable()
export class ClientsService {
  constructor(@Inject(TenantPrismaService) private readonly db: TenantPrismaService) {}

  /**
   * Resolve o cliente pelo `externalId` no tenant atual. Com `create`, cria se não existir
   * (idempotente, também sob concorrência); sem `create`, lança NotFoundError.
   */
  async resolve(externalId: string, opts: { create?: boolean } = {}): Promise<ClientRef> {
    const { tenantId } = TenantContext.current();
    assertExternalId(externalId);
    const where = { tenantId_externalId: { tenantId, externalId } };
    const select = { id: true, externalId: true } as const;

    const found = await this.db.client.client.findUnique({ where, select });
    if (found) return found;
    if (!opts.create) throw new NotFoundError("Cliente não encontrado");

    try {
      return await this.db.client.client.create({ data: { tenantId, externalId }, select });
    } catch (err) {
      // Outra requisição criou o mesmo cliente entre o find e o create.
      if (!isUniqueViolation(err)) throw err;
      const created = await this.db.client.client.findUnique({ where, select });
      if (!created) throw err;
      return created;
    }
  }

  /** Clientes do tenant atual, em ordem de criação. */
  async list(): Promise<ClientSummary[]> {
    const { tenantId } = TenantContext.current();
    return this.db.client.client.findMany({
      where: { tenantId },
      select: { id: true, externalId: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { externalId: "asc" }],
    });
  }
}
