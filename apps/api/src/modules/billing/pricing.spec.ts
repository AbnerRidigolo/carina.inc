import { WorkTypeSchema } from "@carina/shared";
import { describe, expect, it } from "vitest";
import { Prisma } from "../../generated/prisma/client.js";
import { classifyWork, computeExecutionPrice, extractValueBrl, PRICE_BRL } from "./pricing.js";

const Decimal = Prisma.Decimal;

describe("PRICE_BRL", () => {
  it("segue a tabela de preços, com todos os tipos de trabalho", () => {
    expect(PRICE_BRL).toEqual({
      query: "1.50",
      analysis: "7.50",
      multi_agent_analysis: "15.00",
      optimization: "30.00",
      execution: "75.00",
      data_query: "0.05",
      data_ingestion: "0.05",
      evaluation: "5.00",
      backtest: "7.50",
    });
    expect(Object.keys(PRICE_BRL).sort()).toEqual([...WorkTypeSchema.options].sort());
  });
});

describe("classifyWork", () => {
  it.each([
    [[], "query"],
    [["insight"], "analysis"],
    [["risk"], "analysis"],
    [["insight", "risk"], "multi_agent_analysis"],
    [["insight", "predictor", "risk"], "multi_agent_analysis"],
    [["tax_optimizer"], "optimization"],
    [["tax"], "optimization"],
    [["rebalancer"], "optimization"],
    [["insight", "rebalancer"], "optimization"],
  ] as const)("%j -> %s", (agents, expected) => {
    expect(classifyWork([...agents])).toBe(expected);
  });

  it("agente de otimização vence a contagem de agentes", () => {
    expect(classifyWork(["insight", "risk", "tax"])).toBe("optimization");
  });
});

describe("extractValueBrl", () => {
  it("aceita número e devolve o valor absoluto (venda é negativa)", () => {
    expect(extractValueBrl({ amount: 5000 })?.toString()).toBe("5000");
    expect(extractValueBrl({ amount: -1500.5 })?.toString()).toBe("1500.5");
    expect(extractValueBrl({ valor: -2500 })?.toString()).toBe("2500");
  });

  it("aceita string decimal, sem passar por float", () => {
    expect(extractValueBrl({ value_brl: "0.10" })?.toString()).toBe("0.1");
    expect(extractValueBrl({ valueBrl: "-1234567890123.45" })?.toString()).toBe("1234567890123.45");
    expect(extractValueBrl({ value: " 42.5 " })?.toString()).toBe("42.5");
  });

  it("respeita a precedência value_brl, valueBrl, amount, value, valor", () => {
    expect(extractValueBrl({ value_brl: 10, amount: 99 })?.toString()).toBe("10");
    expect(extractValueBrl({ valueBrl: 20, amount: 99, value: 98, valor: 97 })?.toString()).toBe(
      "20",
    );
    expect(extractValueBrl({ amount: 30, value: 98, valor: 97 })?.toString()).toBe("30");
    expect(extractValueBrl({ value: 40, valor: 97 })?.toString()).toBe("40");
    expect(extractValueBrl({ valor: 50 })?.toString()).toBe("50");
  });

  it("ausente, boolean ou não numérico dá undefined", () => {
    expect(extractValueBrl({})).toBeUndefined();
    expect(extractValueBrl({ value_brl: true })).toBeUndefined();
    expect(extractValueBrl({ amount: false })).toBeUndefined();
    expect(extractValueBrl({ amount: "muito" })).toBeUndefined();
    expect(extractValueBrl({ amount: "" })).toBeUndefined();
    expect(extractValueBrl({ amount: Number.NaN })).toBeUndefined();
    expect(extractValueBrl({ amount: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(extractValueBrl({ amount: null })).toBeUndefined();
    expect(extractValueBrl({ amount: { x: 1 } })).toBeUndefined();
  });

  it("chave inválida não esconde uma chave válida seguinte", () => {
    expect(extractValueBrl({ value_brl: true, amount: 7 })?.toString()).toBe("7");
    expect(extractValueBrl({ value_brl: "x", valor: "8" })?.toString()).toBe("8");
  });
});

describe("computeExecutionPrice", () => {
  it("0,5% de R$100.000 = R$500 de fee + R$75 base", () => {
    expect(computeExecutionPrice(new Decimal("100000"), 0.5)).toEqual({
      priceBrl: new Decimal("575.00"),
      feeBrl: new Decimal("500.00"),
    });
  });

  it("sem valor movimentado cobra só o preço base", () => {
    const r = computeExecutionPrice(new Decimal(0), 0.5);
    expect(r.feeBrl.toFixed(2)).toBe("0.00");
    expect(r.priceBrl.toFixed(2)).toBe("75.00");
  });

  it("arredonda o fee meio para cima em 2 casas", () => {
    // 0,5% de 100,30 = 0,5015 -> 0,50
    expect(computeExecutionPrice(new Decimal("100.30"), 0.5).feeBrl.toFixed(2)).toBe("0.50");
    // 0,5% de 1,00 = 0,005 -> 0,01 (o meio sobe); 0,5% de 0,01 = 0,00005 -> 0,00
    expect(computeExecutionPrice(new Decimal("1"), 0.5).feeBrl.toFixed(2)).toBe("0.01");
    expect(computeExecutionPrice(new Decimal("0.01"), 0.5).feeBrl.toFixed(2)).toBe("0.00");
    // 1% de 12,50 = 0,125 -> 0,13
    expect(computeExecutionPrice(new Decimal("12.50"), 1).feeBrl.toFixed(2)).toBe("0.13");
  });

  it("é exato onde o float erra", () => {
    // 0,5% de 201 = 1,005 -> 1,01 (em float, 1.005 * 100 dá 100.49999999999999)
    expect(computeExecutionPrice(new Decimal("201"), 0.5).feeBrl.toFixed(2)).toBe("1.01");
    expect(computeExecutionPrice(new Decimal("201"), 0.5).priceBrl.toFixed(2)).toBe("76.01");
  });

  it("fee de 0% e valor muito grande", () => {
    expect(computeExecutionPrice(new Decimal("100000"), 0).priceBrl.toFixed(2)).toBe("75.00");
    const big = computeExecutionPrice(new Decimal("9999999999999999.99"), 0.5);
    expect(big.feeBrl.toFixed(2)).toBe("50000000000000.00");
    expect(big.priceBrl.toFixed(2)).toBe("50000000000075.00");
  });

  it("valor negativo não gera fee negativo", () => {
    expect(computeExecutionPrice(new Decimal("-100"), 0.5).feeBrl.toFixed(2)).toBe("0.00");
  });

  it("rejeita percentual inválido", () => {
    expect(() => computeExecutionPrice(new Decimal(1), -1)).toThrow(RangeError);
    expect(() => computeExecutionPrice(new Decimal(1), Number.NaN)).toThrow(RangeError);
  });
});
