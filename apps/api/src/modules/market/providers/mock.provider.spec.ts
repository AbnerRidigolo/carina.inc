import { HistoricalBarSchema, MacroIndicatorSchema, QuoteSchema } from "@carina/shared";
import { describe, expect, it } from "vitest";
import { FIIS, STOCKS } from "../../data-ingestion/synthetic/profiles.js";
import { MOCK_PRICES, MockMarketProvider } from "./mock.provider.js";

const NOW = Date.parse("2026-11-14T15:00:00Z");
const provider = () => new MockMarketProvider(() => NOW);

describe("MockMarketProvider", () => {
  it("cota PETR4 a 30.00 com a hora do relógio e source mock", async () => {
    const [quote] = await provider().fetchQuotes(["PETR4"]);
    expect(quote?.price).toBe("30.00");
    expect(quote?.updatedAt).toBe(new Date(NOW).toISOString());
    expect(quote?.source).toBe("mock");
    expect(quote?.assetClass).toBe("stock");
    expect(QuoteSchema.omit({ marketState: true }).safeParse(quote).success).toBe(true);
  });

  it("omite símbolo fora da tabela", async () => {
    const quotes = await provider().fetchQuotes(["PETR4", "ZZZZ9"]);
    expect(quotes.map((q) => q.symbol)).toEqual(["PETR4"]);
  });

  it("histórico é determinístico e coerente", async () => {
    const a = await provider().fetchHistory("PETR4", "1mo");
    const b = await provider().fetchHistory("PETR4", "1mo");
    expect(a).toEqual(b);
    expect(a.length).toBe(21);
    for (const bar of a) {
      expect(HistoricalBarSchema.safeParse(bar).success).toBe(true);
      const open = Number(bar.open);
      const close = Number(bar.close);
      expect(Number(bar.high)).toBeGreaterThanOrEqual(Math.max(open, close));
      expect(Number(bar.low)).toBeLessThanOrEqual(Math.min(open, close));
    }
    expect(a.at(-1)?.close).toBe("30.00");
  });

  it("histórico de símbolos diferentes difere e símbolo desconhecido volta vazio", async () => {
    const p = provider();
    expect(await p.fetchHistory("VALE3", "1mo")).not.toEqual(await p.fetchHistory("PETR4", "1mo"));
    expect(await p.fetchHistory("ZZZZ9", "1mo")).toEqual([]);
  });

  it("macro traz selic, cdi, ipca e ptax_usd", async () => {
    const macro = await provider().fetchMacro();
    expect(macro.map((m) => m.code).sort()).toEqual(["cdi", "ipca", "ptax_usd", "selic"]);
    for (const m of macro) expect(MacroIndicatorSchema.safeParse(m).success).toBe(true);
  });

  it("todo ativo dos perfis sintéticos está em MOCK_PRICES", () => {
    for (const { code } of [...STOCKS, ...FIIS]) expect(MOCK_PRICES).toHaveProperty(code);
    for (const code of [
      "VALE3",
      "ITUB4",
      "BBDC4",
      "BBAS3",
      "MGLU3",
      "HGLG11",
      "KNRI11",
      "IVVB11",
      "BOVA11",
    ])
      expect(MOCK_PRICES).toHaveProperty(code);
  });
});
