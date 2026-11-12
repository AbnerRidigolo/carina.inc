/**
 * Billing: registro append-only de cada resolução cobrável e resumo mensal do tenant.
 *
 * Tudo roda sob RLS (TenantPrismaService) com o tenant do TenantContext atual. `usage_record` é
 * só-INSERT para o carina_app: `record` nunca atualiza nem apaga. Dinheiro é sempre Decimal; o
 * resumo sai como strings de 2 casas (MoneySchema). O mês é o de America/Sao_Paulo, o mesmo da
 * cota mensal.
 */
import type { UsageSummary, WorkType } from "@carina/shared";
import { Inject, Injectable } from "@nestjs/common";
import { ENV } from "../../core/config/config.module.js";
import type { Env } from "../../core/config/env.js";
import { TenantContext } from "../../core/context/tenant-context.js";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import { ValidationError } from "../../core/errors/domain-errors.js";
import { Prisma, type UsageRecord } from "../../generated/prisma/client.js";
import { CLOCK, type Clock } from "../limits/clock.js";
import { monthKey, monthRange } from "../limits/month.js";
import { computeExecutionPrice, MAX_MONEY_BRL, PRICE_BRL } from "./pricing.js";

const Decimal = Prisma.Decimal;

export type UsageRecordRow = UsageRecord;

export interface RecordInput {
  /** Transação em curso (ex.: a da auditoria): o registro entra nela e confirma/desfaz junto. */
  tx?: Prisma.TransactionClient;
  clientId?: string;
  workType: WorkType;
  agents: string[];
  /** Valor movimentado; só gera fee em `execution`. */
  valueBrl?: Prisma.Decimal;
  durationMs: number;
}

/** Garante que `value` cabe em `numeric(18,2)`; o erro sai antes de qualquer SQL. */
function assertFitsColumn(field: string, value: Prisma.Decimal): void {
  if (!value.isFinite() || value.abs().gt(MAX_MONEY_BRL)) {
    throw new ValidationError(
      `${field} fora do intervalo permitido (no máximo ${MAX_MONEY_BRL.toFixed(2)} BRL)`,
    );
  }
}

const money = (d: Prisma.Decimal): string => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

@Injectable()
export class BillingService {
  constructor(
    @Inject(TenantPrismaService) private readonly db: TenantPrismaService,
    @Inject(ENV) private readonly env: Pick<Env, "EXECUTION_FEE_PCT">,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Grava a resolução com o preço aplicado (INSERT; com `tx`, na transação do chamador). */
  async record(input: RecordInput): Promise<UsageRecordRow> {
    // Sem contexto de tenant rejeita (UnauthenticatedError) sem tocar no banco.
    const { tenantId } = TenantContext.current();
    const rawValue = input.valueBrl ?? new Decimal(0);
    // NaN/Infinity e valores acima da coluna viram 422 aqui, antes do INSERT: um erro do banco
    // (inclusive dentro de `tx`) abortaria a transação do chamador, auditoria junto.
    assertFitsColumn("valueBrl", rawValue);
    const valueBrl = rawValue.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    assertFitsColumn("valueBrl", valueBrl);
    const { priceBrl, feeBrl } =
      input.workType === "execution"
        ? computeExecutionPrice(rawValue, this.env.EXECUTION_FEE_PCT)
        : { priceBrl: new Decimal(PRICE_BRL[input.workType]), feeBrl: new Decimal(0) };
    assertFitsColumn("feeBrl", feeBrl);
    assertFitsColumn("priceBrl", priceBrl);

    const usageRecord = input.tx ? input.tx.usageRecord : this.db.client.usageRecord;
    return usageRecord.create({
      data: {
        tenantId,
        clientId: input.clientId ?? null,
        workType: input.workType,
        agents: input.agents,
        priceBrl,
        feeBrl,
        valueBrl,
        durationMs: input.durationMs,
      },
    });
  }

  /** Resumo do mês `YYYY-MM` (default: o mês corrente em São Paulo) do tenant atual. */
  async summary(month?: string): Promise<UsageSummary> {
    const key = month ?? monthKey(this.clock());
    const range = monthRange(key);
    if (!range) throw new ValidationError("month precisa estar no formato YYYY-MM");

    const groups = await this.db.client.usageRecord.groupBy({
      by: ["workType"],
      where: { createdAt: { gte: new Date(range.startMs), lt: new Date(range.endMs) } },
      _count: { _all: true },
      _sum: { priceBrl: true },
    });

    const byWorkType: UsageSummary["byWorkType"] = {};
    let resolutions = 0;
    let total = new Decimal(0);
    for (const g of groups) {
      const sum = g._sum.priceBrl ?? new Decimal(0);
      byWorkType[g.workType as WorkType] = { count: g._count._all, totalBrl: money(sum) };
      resolutions += g._count._all;
      total = total.plus(sum);
    }
    return { month: key, resolutions, totalBrl: money(total), byWorkType };
  }
}
