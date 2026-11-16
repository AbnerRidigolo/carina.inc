import { describe, expect, it } from "vitest";
import {
  HistoryRangeSchema,
  MacroIndicatorSchema,
  MarketQuotesResponseSchema,
  PriceSchema,
  QuoteSchema,
} from "./market.js";

const quote = {
  symbol: "PETR4",
  name: "Petrobras PN",
  assetClass: "stock",
  price: "38.50",
  changePct: "-1.25",
  previousClose: "39.00",
  volume: "1000000",
  currency: "BRL",
  updatedAt: "2026-11-14T13:00:00.000Z",
  marketState: "open",
  source: "mock",
};

describe("PriceSchema", () => {
  it.each(["30.00", "0.000001", "0", "999999999999", "12.5"])("aceita %s", (v) => {
    expect(PriceSchema.safeParse(v).success).toBe(true);
  });

  it.each(["-1", "1e3", "1,5", "", "1234567890123", "1.1234567", ".5", "1."])("rejeita %s", (v) => {
    expect(PriceSchema.safeParse(v).success).toBe(false);
  });

  it("rejeita number", () => {
    expect(PriceSchema.safeParse(10).success).toBe(false);
  });
});

describe("QuoteSchema", () => {
  it("aceita uma cotação válida", () => {
    expect(QuoteSchema.safeParse(quote).success).toBe(true);
  });

  it("recusa price negativo", () => {
    expect(QuoteSchema.safeParse({ ...quote, price: "-1" }).success).toBe(false);
  });

  it("recusa currency USD", () => {
    expect(QuoteSchema.safeParse({ ...quote, currency: "USD" }).success).toBe(false);
  });

  it("aceita campos anuláveis nulos", () => {
    const r = QuoteSchema.safeParse({
      ...quote,
      changePct: null,
      previousClose: null,
      volume: null,
    });
    expect(r.success).toBe(true);
  });
});

describe("HistoryRangeSchema", () => {
  it("aceita os intervalos suportados", () => {
    for (const r of ["5d", "1mo", "3mo", "6mo", "1y", "2y", "5y"]) {
      expect(HistoryRangeSchema.safeParse(r).success).toBe(true);
    }
  });

  it("recusa 10y", () => {
    expect(HistoryRangeSchema.safeParse("10y").success).toBe(false);
  });
});

describe("MacroIndicatorSchema", () => {
  const macro = {
    code: "selic",
    name: "Selic",
    value: "-0.5",
    unit: "% a.a.",
    referenceDate: "2026-11-13",
  };
  it("aceita valor com sinal e recusa number", () => {
    expect(MacroIndicatorSchema.safeParse(macro).success).toBe(true);
    expect(MacroIndicatorSchema.safeParse({ ...macro, value: 1.5 }).success).toBe(false);
  });
});

describe("MarketQuotesResponseSchema", () => {
  it("exige usage data_query a 0.05", () => {
    const usage = { workType: "data_query", priceBrl: "0.05" };
    expect(MarketQuotesResponseSchema.safeParse({ quotes: [quote], usage }).success).toBe(true);
    expect(
      MarketQuotesResponseSchema.safeParse({
        quotes: [quote],
        usage: { ...usage, priceBrl: "0.10" },
      }).success,
    ).toBe(false);
  });
});
