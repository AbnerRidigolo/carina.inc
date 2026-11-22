import { describe, expect, it } from "vitest";
import { formatBrl, formatDateTime, formatPrice, formatVariationPct, sumMoney } from "./format";

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

describe("formatPrice", () => {
  it("formata cotação em R$ arredondando para centavos", () => {
    expect(formatPrice("31.40")).toBe("R$ 31,40");
    expect(formatPrice("31.4567")).toBe("R$ 31,46");
    expect(formatPrice("0.000001")).toBe("R$ 0,00");
  });
  it("valor inválido vira travessão", () => {
    expect(formatPrice("-1")).toBe("—");
    expect(formatPrice("abc")).toBe("—");
  });
});

describe("formatVariationPct", () => {
  it("mostra o valor absoluto com uma casa e vírgula", () => {
    expect(formatVariationPct("-6.2")).toBe("6,2");
    expect(formatVariationPct("6.24")).toBe("6,2");
    expect(formatVariationPct("-5")).toBe("5,0");
    expect(formatVariationPct("12.345678")).toBe("12,3");
  });
  it("valor inválido vira travessão", () => {
    expect(formatVariationPct("x")).toBe("—");
  });
});
