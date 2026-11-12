/**
 * SQL da ingestão (position e transaction).
 *
 * - Escritas em lote: um `INSERT … SELECT … FROM unnest(…) ON CONFLICT … DO UPDATE` por lote, com
 *   os valores como arrays parametrizados (nada de SQL montado com strings; `$queryRaw`/`$executeRaw`
 *   só em template). Roda sempre dentro de uma `tx` do TenantPrismaService.
 * - `tenant_id`/`client_id` gravados vêm de `current_setting('app.*')`, o mesmo contexto que o RLS
 *   (`tenant_client`) usa para filtrar e checar: nenhum id de tenant/cliente vem de fora do SQL.
 * - O `ON CONFLICT DO UPDATE` não pode tocar a mesma linha duas vezes no mesmo comando: quem chama
 *   deduplica o lote por `externalId` antes (o último vence).
 * - Leituras usam os modelos do Prisma pelo `TenantPrismaService.client` (RLS aplicado), sempre sob
 *   `TenantContext.withClient`.
 */
import type { NormalizedPosition, NormalizedTransaction } from "@carina/shared";
import { Inject, Injectable } from "@nestjs/common";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import { ValidationError } from "../../core/errors/domain-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { sqlState } from "../knowledge/knowledge.repository.js";
import type { Source } from "./provider.js";

type Tx = Prisma.TransactionClient;

export interface ListTransactionsQuery {
  /** Datas `YYYY-MM-DD`, inclusivas. */
  from?: string;
  to?: string;
  limit: number;
}

const toDay = (d: Date): string => d.toISOString().slice(0, 10);
const startOfDay = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

// Leituras devolvem o contrato `Normalized*`: dinheiro e quantidade como strings exatas, datas
// `YYYY-MM-DD`, campos opcionais ausentes omitidos, sem ids nem colunas internas.

/** Decimal do Prisma → string de 2 casas (MoneySchema); nunca passa por `number`. */
const money = (d: Prisma.Decimal): string => d.toFixed(2);
/** Decimal → string sem zeros à direita e sem notação científica (QuantitySchema). */
const quantity = (d: Prisma.Decimal): string => d.toFixed();

/**
 * Erro da classe 22 do SQLSTATE (data exception: data inválida, número fora da faixa, byte
 * inválido como o NUL em texto) = dado do lote que o banco não aceita → 422, não 500.
 */
function mapDataException(err: unknown): never {
  if (sqlState(err)?.startsWith("22")) {
    throw new ValidationError(
      "O lote tem um valor que o banco não aceita (data, número ou texto inválido)",
    );
  }
  throw err;
}

@Injectable()
export class IngestionRepository {
  constructor(@Inject(TenantPrismaService) private readonly db: TenantPrismaService) {}

  /**
   * Upsert por `(tenant_id, client_id, source, external_id)`; devolve quantas linhas foram
   * inseridas ou atualizadas. Campos opcionais ausentes viram NULL (o item enviado substitui a linha toda).
   * `items` não pode repetir `externalId`.
   */
  async upsertPositions(
    tx: Tx,
    source: Source,
    items: readonly NormalizedPosition[],
  ): Promise<number> {
    if (items.length === 0) return 0;
    const externalIds = items.map((i) => i.externalId);
    const institutions = items.map((i) => i.institution);
    const kinds = items.map((i) => i.kind);
    const assetClasses = items.map((i) => i.assetClass);
    const assetCodes = items.map((i) => i.assetCode ?? null);
    const names = items.map((i) => i.name);
    const quantities = items.map((i) => i.quantity ?? null);
    const values = items.map((i) => i.valueBrl);
    const asOfs = items.map((i) => i.asOf);
    try {
      return await tx.$executeRaw`
        INSERT INTO position (tenant_id, client_id, source, external_id, institution, kind,
                              asset_class, asset_code, name, quantity, value_brl, as_of)
        SELECT current_setting('app.tenant_id')::uuid, current_setting('app.client_id')::uuid,
               ${source}::text, t.external_id, t.institution, t.kind, t.asset_class, t.asset_code,
               t.name, t.quantity::numeric, t.value_brl::numeric, t.as_of::date
        FROM unnest(
          ${externalIds}::text[], ${institutions}::text[], ${kinds}::text[],
          ${assetClasses}::text[], ${assetCodes}::text[], ${names}::text[],
          ${quantities}::text[], ${values}::text[], ${asOfs}::text[]
        ) AS t(external_id, institution, kind, asset_class, asset_code, name, quantity,
               value_brl, as_of)
        ON CONFLICT (tenant_id, client_id, source, external_id) DO UPDATE
          SET institution = EXCLUDED.institution,
              kind = EXCLUDED.kind,
              asset_class = EXCLUDED.asset_class,
              asset_code = EXCLUDED.asset_code,
              name = EXCLUDED.name,
              quantity = EXCLUDED.quantity,
              value_brl = EXCLUDED.value_brl,
              as_of = EXCLUDED.as_of,
              updated_at = now()`;
    } catch (err) {
      return mapDataException(err);
    }
  }

  /** Idem para transações. */
  async upsertTransactions(
    tx: Tx,
    source: Source,
    items: readonly NormalizedTransaction[],
  ): Promise<number> {
    if (items.length === 0) return 0;
    const externalIds = items.map((i) => i.externalId);
    const institutions = items.map((i) => i.institution);
    const accounts = items.map((i) => i.account);
    const dates = items.map((i) => i.date);
    const descriptions = items.map((i) => i.description);
    const amounts = items.map((i) => i.amountBrl);
    const categories = items.map((i) => i.category ?? null);
    const kinds = items.map((i) => i.kind);
    const assetCodes = items.map((i) => i.assetCode ?? null);
    const quantities = items.map((i) => i.quantity ?? null);
    try {
      return await tx.$executeRaw`
        INSERT INTO "transaction" (tenant_id, client_id, source, external_id, institution, account,
                                   date, description, amount_brl, category, kind, asset_code,
                                   quantity)
        SELECT current_setting('app.tenant_id')::uuid, current_setting('app.client_id')::uuid,
               ${source}::text, t.external_id, t.institution, t.account, t.date::date,
               t.description, t.amount_brl::numeric, t.category, t.kind, t.asset_code,
               t.quantity::numeric
        FROM unnest(
          ${externalIds}::text[], ${institutions}::text[], ${accounts}::text[], ${dates}::text[],
          ${descriptions}::text[], ${amounts}::text[], ${categories}::text[], ${kinds}::text[],
          ${assetCodes}::text[], ${quantities}::text[]
        ) AS t(external_id, institution, account, date, description, amount_brl, category, kind,
               asset_code, quantity)
        ON CONFLICT (tenant_id, client_id, source, external_id) DO UPDATE
          SET institution = EXCLUDED.institution,
              account = EXCLUDED.account,
              date = EXCLUDED.date,
              description = EXCLUDED.description,
              amount_brl = EXCLUDED.amount_brl,
              category = EXCLUDED.category,
              kind = EXCLUDED.kind,
              asset_code = EXCLUDED.asset_code,
              quantity = EXCLUDED.quantity`;
    } catch (err) {
      return mapDataException(err);
    }
  }

  /** Posições do cliente fixado no TenantContext, no contrato `NormalizedPosition`. */
  async listPositions(clientId: string): Promise<NormalizedPosition[]> {
    const rows = await this.db.client.position.findMany({
      where: { clientId },
      orderBy: [{ assetClass: "asc" }, { name: "asc" }, { externalId: "asc" }, { source: "asc" }],
    });
    return rows.map((r) => ({
      externalId: r.externalId,
      institution: r.institution,
      kind: r.kind as NormalizedPosition["kind"],
      assetClass: r.assetClass as NormalizedPosition["assetClass"],
      ...(r.assetCode !== null ? { assetCode: r.assetCode } : {}),
      name: r.name,
      ...(r.quantity !== null ? { quantity: quantity(r.quantity) } : {}),
      valueBrl: money(r.valueBrl),
      asOf: toDay(r.asOf),
    }));
  }

  /** Transações do cliente, mais recentes primeiro, no contrato `NormalizedTransaction`. */
  async listTransactions(
    clientId: string,
    q: ListTransactionsQuery,
  ): Promise<NormalizedTransaction[]> {
    const date = {
      ...(q.from !== undefined ? { gte: startOfDay(q.from) } : {}),
      ...(q.to !== undefined ? { lte: startOfDay(q.to) } : {}),
    };
    const rows = await this.db.client.transaction.findMany({
      where: { clientId, ...(q.from !== undefined || q.to !== undefined ? { date } : {}) },
      orderBy: [{ date: "desc" }, { externalId: "asc" }, { source: "asc" }],
      take: q.limit,
    });
    return rows.map((r) => ({
      externalId: r.externalId,
      institution: r.institution,
      account: r.account,
      date: toDay(r.date),
      description: r.description,
      amountBrl: money(r.amountBrl),
      kind: r.kind as NormalizedTransaction["kind"],
      ...(r.category !== null ? { category: r.category } : {}),
      ...(r.assetCode !== null ? { assetCode: r.assetCode } : {}),
      ...(r.quantity !== null ? { quantity: quantity(r.quantity) } : {}),
    }));
  }
}
