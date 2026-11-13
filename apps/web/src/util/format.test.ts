import { describe, expect, it } from "vitest";
import { formatBrl, formatDateTime, sumMoney } from "./format";

describe("formatBrl", () => {
  it("formata em pt-BR com R$", () => {
    expect(formatBrl("7.50")).toBe("R$ 7,50");
    expect(formatBrl("1234567.8")).toBe("R$ 1.234.567,80");
    expect(formatBrl("-10")).toBe("-R$ 10,00");
  });
  it("não passa por ponto flutuante (16 dígitos inteiros preservados)", () => {
    expect(formatBrl("9007199254740993.01")).toBe("R$ 9.007.199.254.740.993,01");
  });
  it("valor que não é dinheiro vira travessão", () => {
    expect(formatBrl("abc")).toBe("—");
    expect(formatBrl("1e3")).toBe("—");
  });
});

describe("sumMoney", () => {
  it("soma exata em centavos", () => {
    expect(sumMoney(["0.10", "0.20"])).toBe("0.30");
    expect(sumMoney(["10", "-2.5", "0.05"])).toBe("7.55");
    expect(sumMoney([])).toBe("0.00");
    expect(sumMoney(["-0.01"])).toBe("-0.01");
  });
});

describe("formatDateTime", () => {
  it("data inválida vira travessão", () => {
    expect(formatDateTime("nope")).toBe("—");
  });
});
