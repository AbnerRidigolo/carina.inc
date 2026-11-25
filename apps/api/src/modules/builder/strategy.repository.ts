/**
 * SQL das estratégias declarativas (spec §4, tabela `strategy` da migração 0010). Tudo sob RLS por
 * tenant: cada método recebe a `tx` aberta por `TenantPrismaService.tx` com o tenant fixado (o
 * repositório não guarda estado nem abre transação).
 *
 * - `create`: serializa as criações do tenant com `pg_advisory_xact_lock` e conta na mesma
 *   transação, então duas criações simultâneas com 99 gravadas não passam juntas do limite de 100;
 * - `list`: as do tenant, mais novas primeiro;
 * - `get`: id malformado → `null` sem consultar (nunca 500 por cast de uuid).
 */
import { STRATEGY_MAX_PER_TENANT, type Strategy, type StrategyCreate } from "@carina/shared";
import { Injectable } from "@nestjs/common";
import { TenantContext } from "../../core/context/tenant-context.js";
import { ValidationError } from "../../core/errors/domain-errors.js";
import { Prisma } from "../../generated/prisma/client.js";

type Tx = Prisma.TransactionClient;

interface StrategyRow {
  id: string;
  name: string;
  kind: Strategy["spec"]["kind"];
  symbol: string;
  fast: number;
  slow: number;
  created_at: Date;
}

const STRATEGY_COLUMNS = Prisma.sql`id::text, name, kind, symbol, fast, slow, created_at`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toStrategy(row: StrategyRow): Strategy {
  return {
    id: row.id,
    name: row.name,
    spec: { kind: row.kind, symbol: row.symbol, fast: row.fast, slow: row.slow },
    createdAt: row.created_at.toISOString(),
  };
}

@Injectable()
export class StrategyRepository {
  /**
   * Grava a estratégia no tenant fixado. A entrada já vem validada pelo `StrategyCreateSchema`
   * (os CHECKs do banco são a última barreira).
   *
   * @throws ValidationError (422) se o tenant já tem `STRATEGY_MAX_PER_TENANT` estratégias.
   */
  async create(tx: Tx, input: StrategyCreate): Promise<Strategy> {
    const { tenantId } = TenantContext.current();
    // Serializa as criações do mesmo tenant até o fim da transação. Em READ COMMITTED (o padrão de
    // `TenantPrismaService.tx`) a contagem abaixo tira um snapshot novo DEPOIS do lock e enxerga o
    // que a criação anterior gravou e confirmou. Com REPEATABLE READ/SERIALIZABLE o snapshot seria
    // o do primeiro comando da transação: não abra esta `tx` com outro isolamento.
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
        'strategy_create', ${tenantId}::text
      )::text, 0)) IS NULL AS locked`;
    const counted = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM strategy WHERE tenant_id = ${tenantId}::uuid`;
    if ((counted[0]?.n ?? 0) >= STRATEGY_MAX_PER_TENANT) {
      throw new ValidationError(
        `Limite de ${String(STRATEGY_MAX_PER_TENANT)} estratégias por tenant atingido`,
      );
    }
    const { kind, symbol, fast, slow } = input.spec;
    const rows = await tx.$queryRaw<StrategyRow[]>`
      INSERT INTO strategy (tenant_id, name, kind, symbol, fast, slow)
      VALUES (${tenantId}::uuid, ${input.name}, ${kind}, ${symbol}, ${fast}, ${slow})
      RETURNING ${STRATEGY_COLUMNS}`;
    const inserted = rows[0];
    if (inserted === undefined) throw new Error("INSERT em strategy não devolveu a linha");
    return toStrategy(inserted);
  }

  /** Estratégias do tenant fixado, mais novas primeiro. */
  async list(tx: Tx): Promise<Strategy[]> {
    const rows = await tx.$queryRaw<StrategyRow[]>`
      SELECT ${STRATEGY_COLUMNS}
        FROM strategy
       ORDER BY created_at DESC, id DESC`;
    return rows.map(toStrategy);
  }

  /** Estratégia do tenant fixado; `null` se o id é malformado, não existe ou é de outro tenant. */
  async get(tx: Tx, id: string): Promise<Strategy | null> {
    if (!UUID_RE.test(id)) return null;
    const rows = await tx.$queryRaw<StrategyRow[]>`
      SELECT ${STRATEGY_COLUMNS} FROM strategy WHERE id = ${id}::uuid`;
    const row = rows[0];
    return row === undefined ? null : toStrategy(row);
  }
}
