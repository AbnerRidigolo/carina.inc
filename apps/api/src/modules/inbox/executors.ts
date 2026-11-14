/**
 * Registro de executores das ações aprovadas. No boot (e em `resetDefaults`) são registrados os
 * executores SIMULADOS da fase 1: nenhum fala com corretora ou banco de verdade. Fases futuras
 * trocam por `register(action, fn)`.
 *
 * Um executor roda FORA de qualquer transação do banco (efeito externo não é reversível por
 * rollback) e sob o TenantContext do tenant e do cliente da aprovação.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";

export interface ExecutorContext {
  tenantId: string;
  /** uuid interno do cliente */
  clientId: string;
  approvalId: string;
}

export type Executor = (
  payload: Record<string, unknown>,
  ctx?: ExecutorContext,
) => Promise<unknown>;

const simId = () => `SIM-${randomBytes(4).toString("hex")}`;

/** Leituras no máximo desta quantidade de linhas (executor simulado). */
const READ_LIMIT = 100;

@Injectable()
export class ExecutorRegistry {
  private readonly executors = new Map<string, Executor>();

  constructor(@Inject(TenantPrismaService) private readonly db: TenantPrismaService) {
    this.resetDefaults();
  }

  register(action: string, fn: Executor): void {
    this.executors.set(action, fn);
  }

  get(action: string): Executor | undefined {
    return this.executors.get(action);
  }

  /** Descarta os registros e volta aos executores simulados do boot. */
  resetDefaults(): void {
    this.executors.clear();
    this.register("place_trade", () => Promise.resolve({ orderId: simId(), status: "filled" }));
    for (const action of ["transfer", "rebalance"]) {
      this.register(action, () => Promise.resolve({ protocol: simId(), status: "accepted" }));
    }
    this.register("create_alert", () => Promise.resolve({ alertId: randomUUID() }));

    // READ: leem as tabelas do cliente (sob RLS, com o contexto do cliente já fixado).
    this.register("get_positions", async () => {
      const rows = await this.db.client.position.findMany({
        orderBy: [{ externalId: "asc" }, { source: "asc" }],
        take: READ_LIMIT,
        select: { externalId: true, name: true, assetClass: true, valueBrl: true },
      });
      return {
        positions: rows.map((r) => ({ ...r, valueBrl: r.valueBrl.toFixed(2) })),
      };
    });
    this.register("get_transactions", async () => {
      const rows = await this.db.client.transaction.findMany({
        orderBy: [{ date: "desc" }, { externalId: "asc" }],
        take: READ_LIMIT,
        select: { externalId: true, date: true, description: true, amountBrl: true, kind: true },
      });
      return {
        transactions: rows.map((r) => ({
          ...r,
          date: r.date.toISOString().slice(0, 10),
          amountBrl: r.amountBrl.toFixed(2),
        })),
      };
    });
    this.register("analyze_portfolio", async () => {
      const groups = await this.db.client.position.groupBy({
        by: ["assetClass"],
        _sum: { valueBrl: true },
        _count: { _all: true },
      });
      return {
        byAssetClass: groups
          .map((g) => ({
            assetClass: g.assetClass,
            count: g._count._all,
            totalBrl: g._sum.valueBrl?.toFixed(2) ?? "0.00",
          }))
          .sort((a, b) => (a.assetClass < b.assetClass ? -1 : a.assetClass > b.assetClass ? 1 : 0)),
      };
    });
  }
}
