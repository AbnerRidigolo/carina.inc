/**
 * Precificação por resolução (porta de legacy/python/carina/b2b/metering.py), em decimal exato:
 * nenhum valor monetário passa por `number`. Preço em BRL como string decimal de 2 casas.
 */
import type { WorkType } from "@carina/shared";
import { Prisma } from "../../generated/prisma/client.js";

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

/** Preço base B2B por resolução, em BRL (docs/B2B.md). */
export const PRICE_BRL: Record<WorkType, string> = {
  query: "1.50",
  analysis: "7.50",
  multi_agent_analysis: "15.00",
  optimization: "30.00",
  execution: "75.00",
  data_query: "0.05",
  data_ingestion: "0.05",
  evaluation: "5.00",
  backtest: "7.50",
};

/** Agentes cuja participação classifica a resolução como otimização. */
const OPTIMIZATION_AGENTS: ReadonlySet<string> = new Set(["tax", "tax_optimizer", "rebalancer"]);

/**
 * Classifica o trabalho pelos agentes do plano: algum agente de otimização → `optimization`;
 * nenhum → `query`; um → `analysis`; dois ou mais → `multi_agent_analysis`.
 */
export function classifyWork(agents: string[]): WorkType {
  if (agents.some((a) => OPTIMIZATION_AGENTS.has(a))) return "optimization";
  if (agents.length === 0) return "query";
  if (agents.length === 1) return "analysis";
  return "multi_agent_analysis";
}

/** Chaves do payload onde o valor movimentado de uma execução pode estar, em ordem de precedência. */
const VALUE_KEYS = ["value_brl", "valueBrl", "amount", "value", "valor"] as const;

const DECIMAL_STRING_RE = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;

function toDecimal(raw: unknown): Decimal | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? new Decimal(raw) : undefined;
  if (typeof raw === "string") {
    const s = raw.trim();
    return DECIMAL_STRING_RE.test(s) ? new Decimal(s) : undefined;
  }
  return undefined; // boolean, null, objeto…
}

/**
 * Valor movimentado (BRL, absoluto) do payload de uma execução. Número ou string decimal; uma
 * chave ausente ou inválida cede a vez à próxima; sem nenhuma válida, 0 (cobra só o preço base).
 */
export function extractValueBrl(payload: Record<string, unknown>): Decimal {
  for (const key of VALUE_KEYS) {
    const value = toDecimal(payload[key]);
    if (value) return value.abs();
  }
  return new Decimal(0);
}

/**
 * Preço de uma execução: `fee = round_half_up(value × feePct / 100, 2)` e `price = 75.00 + fee`.
 * Sem valor movimentado positivo não há fee.
 */
export function computeExecutionPrice(
  valueBrl: Decimal,
  feePct: number,
): { priceBrl: Decimal; feeBrl: Decimal } {
  if (!Number.isFinite(feePct) || feePct < 0) {
    throw new RangeError(`feePct inválido: ${String(feePct)}`);
  }
  const feeBrl = valueBrl.gt(0)
    ? valueBrl.mul(feePct).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    : new Decimal(0);
  return { priceBrl: new Decimal(PRICE_BRL.execution).plus(feeBrl), feeBrl };
}
