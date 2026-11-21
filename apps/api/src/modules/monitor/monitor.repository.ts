/**
 * SQL do monitor de carteira (spec §4.1–4.3). Tudo sob o TenantPrismaService (RLS):
 * - `tenantIds`: único ponto sem tenant fixado, via `monitor_tenant_ids()` (SECURITY DEFINER,
 *   migrations/0009), que devolve só ids;
 * - `watchList` e `insertIfNew`: recebem a `tx` do job, aberta sob `TenantContext.run` com só o
 *   tenant fixado (todos os clientes dele);
 * - `list`: a `tx` da rota; filtra pelo cliente pedido (com ou sem o cliente fixado no contexto).
 *
 * Valores decimais saem do banco como texto (`trim_scale`), nunca por `number`.
 */
import type { PortfolioAlert, PortfolioAlertPage } from "@carina/shared";
import { Inject, Injectable } from "@nestjs/common";
import { TenantContext } from "../../core/context/tenant-context.js";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import { ValidationError } from "../../core/errors/domain-errors.js";
import { Prisma } from "../../generated/prisma/client.js";

type Tx = Prisma.TransactionClient;

/** Par cliente × ativo a vigiar (código normalizado: maiúsculas, sem espaços). */
export interface WatchItem {
  clientId: string;
  assetCode: string;
}

/** Alerta a gravar; `tradingDay` é a data do pregão em America/Sao_Paulo (`YYYY-MM-DD`). */
export interface NewAlert {
  clientId: string;
  assetCode: string;
  direction: "up" | "down";
  /** string decimal com sinal */
  changePct: string;
  /** string decimal */
  price: string;
  tradingDay: string;
}

interface AlertRow {
  id: string;
  asset_code: string;
  direction: "up" | "down";
  change_pct: string;
  price: string;
  trading_day: string;
  created_at: Date;
  /** `created_at` em UTC com microssegundos, para o cursor (Date só guarda milissegundos) */
  created_at_us: string;
}

/** Colunas do alerta, com decimais e data como texto (sem passar por `number` nem fuso). */
const ALERT_COLUMNS = Prisma.sql`
  id::text, asset_code, direction, trim_scale(change_pct)::text AS change_pct,
  trim_scale(price)::text AS price, to_char(trading_day, 'YYYY-MM-DD') AS trading_day, created_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_us`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS_US_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Cursor opaco: base64url de `<created_at em UTC com µs>|<id>` do último item da página. */
export function encodeCursor(createdAtUs: string, id: string): string {
  return Buffer.from(`${createdAtUs}|${id}`, "utf8").toString("base64url");
}

/** Decodifica e valida o cursor; qualquer coisa fora do formato → ValidationError (422). */
export function decodeCursor(cursor: string): { createdAtUs: string; id: string } {
  const invalid = () => new ValidationError("cursor inválido");
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  const [createdAtUs, id, ...rest] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (createdAtUs === undefined || id === undefined || rest.length > 0) throw invalid();
  if (!TS_US_RE.test(createdAtUs) || !UUID_RE.test(id)) throw invalid();
  // Data de calendário real (sem 30 de fevereiro): o ida e volta pelo Date precisa bater.
  const ms = `${createdAtUs.slice(0, 23)}Z`;
  const parsed = new Date(ms);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== ms) throw invalid();
  return { createdAtUs, id: id.toLowerCase() };
}

function toAlert(row: AlertRow): PortfolioAlert {
  return {
    id: row.id,
    assetCode: row.asset_code,
    direction: row.direction,
    changePct: row.change_pct,
    price: row.price,
    tradingDay: row.trading_day,
    createdAt: row.created_at.toISOString(),
  };
}

@Injectable()
export class MonitorRepository {
  constructor(@Inject(TenantPrismaService) private readonly db: TenantPrismaService) {}

  /** Tenants não suspensos com posição de investimento com código de ativo (só ids). */
  tenantIds(): Promise<string[]> {
    return this.db.monitorTenantIds();
  }

  /**
   * Pares (cliente, ativo) distintos das posições de investimento com código, no tenant fixado
   * (RLS). O código sai normalizado (maiúsculas, sem espaços); código só de espaços fica de fora.
   * Ordem por byte (COLLATE "C"), a mesma com qualquer locale do banco.
   */
  watchList(tx: Tx): Promise<WatchItem[]> {
    return tx.$queryRaw<WatchItem[]>`
      SELECT DISTINCT client_id::text COLLATE "C" AS "clientId", code COLLATE "C" AS "assetCode"
        FROM (
          SELECT client_id, upper(regexp_replace(asset_code, '\\s', '', 'g')) AS code
            FROM position
           WHERE kind = 'investment' AND asset_code IS NOT NULL
        ) p
       WHERE code <> ''
       ORDER BY "clientId", "assetCode"`;
  }

  /**
   * Grava o alerta se ainda não há um do mesmo cliente, ativo, dia e sentido (`ON CONFLICT DO
   * NOTHING`). Devolve o alerta gravado, ou `null` se já existia: só o que entrou é publicado.
   */
  async insertIfNew(tx: Tx, row: NewAlert): Promise<PortfolioAlert | null> {
    const { tenantId } = TenantContext.current();
    const rows = await tx.$queryRaw<AlertRow[]>`
      INSERT INTO portfolio_alert
        (tenant_id, client_id, asset_code, direction, change_pct, price, trading_day)
      VALUES (${tenantId}::uuid, ${row.clientId}::uuid, ${row.assetCode}, ${row.direction},
              ${row.changePct}::numeric, ${row.price}::numeric, ${row.tradingDay}::date)
      ON CONFLICT (tenant_id, client_id, asset_code, trading_day, direction) DO NOTHING
      RETURNING ${ALERT_COLUMNS}`;
    const inserted = rows[0];
    return inserted === undefined ? null : toAlert(inserted);
  }

  /**
   * Alertas do cliente, mais novo primeiro, keyset por `(created_at, id)`. `cursor` é o
   * `nextCursor` da página anterior; pede `limit + 1` para saber se há próxima.
   */
  async list(
    tx: Tx,
    clientId: string,
    cursor: string | null,
    limit: number,
  ): Promise<PortfolioAlertPage> {
    const after = cursor === null ? null : decodeCursor(cursor);
    const keyset =
      after === null
        ? Prisma.empty
        : Prisma.sql`AND (created_at, id) < (${after.createdAtUs}::timestamptz, ${after.id}::uuid)`;
    const rows = await tx.$queryRaw<AlertRow[]>`
      SELECT ${ALERT_COLUMNS}
        FROM portfolio_alert
       WHERE client_id = ${clientId}::uuid ${keyset}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toAlert),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor(last.created_at_us, last.id)
          : null,
    };
  }
}
