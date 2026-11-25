import { describe, expect, it } from "vitest";
import {
  BacktestResultSchema,
  StrategyCreateSchema,
  StrategyKindSchema,
  StrategySchema,
  StrategySpecSchema,
} from "./builder.js";

describe("StrategyKindSchema", () => {
  it("aceita buy_hold e sma_cross e recusa o resto", () => {
    expect(StrategyKindSchema.safeParse("buy_hold").success).toBe(true);
    expect(StrategyKindSchema.safeParse("sma_cross").success).toBe(true);
    expect(StrategyKindSchema.safeParse("rsi").success).toBe(false);
  });
});

describe("StrategySpecSchema", () => {
  it("sma_cross exige fast < slow", () => {
    const bad = StrategySpecSchema.safeParse({
      kind: "sma_cross",
      symbol: "PETR4",
      fast: 50,
      slow: 10,
    });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toContain("fast < slow");
    expect(bad.error?.issues[0]?.path).toEqual(["fast"]);
    const igual = StrategySpecSchema.safeParse({
      kind: "sma_cross",
      symbol: "PETR4",
      fast: 5,
      slow: 5,
    });
    expect(igual.success).toBe(false);
    const ok = StrategySpecSchema.parse({ kind: "sma_cross", symbol: "PETR4", fast: 3, slow: 5 });
    expect(ok.fast).toBeLessThan(ok.slow);
  });

  it("buy_hold ignora a regra fast < slow", () => {
    const spec = StrategySpecSchema.parse({
      kind: "buy_hold",
      symbol: "BOVA11",
      fast: 50,
      slow: 10,
    });
    expect(spec.kind).toBe("buy_hold");
  });

  it("aplica os padrões fast=10 e slow=50", () => {
    const spec = StrategySpecSchema.parse({ kind: "buy_hold", symbol: "PETR4" });
    expect(spec.fast).toBe(10);
    expect(spec.slow).toBe(50);
  });

  it("limita as janelas (fast 2..200, slow 3..400, inteiros)", () => {
    const base = { kind: "buy_hold", symbol: "PETR4" };
    expect(StrategySpecSchema.safeParse({ ...base, fast: 1 }).success).toBe(false);
    expect(StrategySpecSchema.safeParse({ ...base, fast: 201 }).success).toBe(false);
    expect(StrategySpecSchema.safeParse({ ...base, slow: 2 }).success).toBe(false);
    expect(StrategySpecSchema.safeParse({ ...base, slow: 401 }).success).toBe(false);
    expect(StrategySpecSchema.safeParse({ ...base, fast: 2.5 }).success).toBe(false);
    expect(StrategySpecSchema.safeParse({ ...base, fast: 200, slow: 400 }).success).toBe(true);
  });

  it("recusa símbolo fora do formato de mercado", () => {
    for (const symbol of ["petr4", "", "PETR4.SA", "ABCDEFGHIJKLM", "PE TR"]) {
      expect(StrategySpecSchema.safeParse({ kind: "buy_hold", symbol }).success).toBe(false);
    }
    expect(StrategySpecSchema.safeParse({ kind: "buy_hold", symbol: "^BVSP" }).success).toBe(true);
  });
});

describe("StrategyCreateSchema", () => {
  const spec = { kind: "buy_hold", symbol: "PETR4" };
  it("exige nome de 1 a 120 caracteres", () => {
    expect(StrategyCreateSchema.safeParse({ name: "Carrega", spec }).success).toBe(true);
    expect(StrategyCreateSchema.safeParse({ name: "", spec }).success).toBe(false);
    expect(StrategyCreateSchema.safeParse({ name: "a".repeat(121), spec }).success).toBe(false);
    expect(StrategyCreateSchema.safeParse({ name: "a".repeat(120), spec }).success).toBe(true);
  });
  it("valida a spec aninhada", () => {
    const r = StrategyCreateSchema.safeParse({
      name: "x",
      spec: { kind: "sma_cross", symbol: "PETR4", fast: 9, slow: 3 },
    });
    expect(r.success).toBe(false);
  });
});

describe("StrategySchema", () => {
  it("descreve id, nome, spec e data de criação", () => {
    const r = StrategySchema.safeParse({
      id: "0b0c0f4e-2a52-4a0e-9a35-0d6a1f4f3b7a",
      name: "Carrega PETR4",
      spec: { kind: "buy_hold", symbol: "PETR4", fast: 10, slow: 50 },
      createdAt: "2026-11-25T12:00:00.000Z",
    });
    expect(r.success).toBe(true);
  });
});

describe("BacktestResultSchema", () => {
  const base = {
    symbol: "PETR4",
    kind: "buy_hold",
    bars: 3,
    start: "2026-01-01",
    end: "2026-01-03",
    totalReturnPct: 21,
    maxDrawdownPct: 0,
    annualizedVolatilityPct: 0,
    trades: 1,
    finalEquity: 121,
    equityCurve: [100, 110, 121],
    usage: { workType: "backtest", priceBrl: "7.50" },
  };
  it("aceita o resultado com a cobrança de R$ 7,50", () => {
    expect(BacktestResultSchema.safeParse(base).success).toBe(true);
  });
  it("recusa cobrança diferente da tabela", () => {
    const r = BacktestResultSchema.safeParse({
      ...base,
      usage: { workType: "backtest", priceBrl: "1.00" },
    });
    expect(r.success).toBe(false);
  });
});
