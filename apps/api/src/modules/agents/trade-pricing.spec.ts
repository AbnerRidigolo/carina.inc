/**
 * Preço de servidor do `place_trade` (spec 5.5, itens 2 a 4): o valor é `quantidade × preço da
 * cotação` em decimal exato, o payload gravado só leva o formato da ordem e os campos do servidor,
 * e qualquer entrada que não dê um valor monetário válido falha fechada com `price_unavailable`.
 */
import type { Quote } from "@carina/shared";
import { describe, expect, it } from "vitest";
import { MODEL_VALUE_KEYS } from "../billing/pricing.js";
import { MarketPriceError } from "../market/market-price-error.js";
import { priceTrade } from "./trade-pricing.js";

const quote = (over: Partial<Quote> = {}): Quote => ({
  symbol: "PETR4",
  name: "Petrobras PN",
  assetClass: "stock",
  price: "30.00",
  changePct: "1.25",
  previousClose: "29.63",
  volume: "1000",
  currency: "BRL",
  updatedAt: "2026-11-14T13:00:00.000Z",
  marketState: "open",
  source: "mock",
  ...over,
});

const trade = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  side: "buy",
  assetCode: "PETR4",
  quantity: 100,
  ...over,
});

function expectPriceUnavailable(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(MarketPriceError);
  expect((caught as MarketPriceError).code).toBe("price_unavailable");
}

describe("priceTrade", () => {
  it("100 × 30.00 → 3000.00, com os campos do servidor no payload", () => {
    const out = priceTrade(trade(), quote());
    expect(out.valueBrl).toBe("3000.00");
    expect(out.payload).toEqual({
      side: "buy",
      assetCode: "PETR4",
      quantity: 100,
      unitPriceBrl: "30.00",
      notionalBrl: "3000.00",
      priceSource: "mock",
      priceAsOf: "2026-11-14T13:00:00.000Z",
      marketState: "open",
    });
  });

  it("guarda a quantidade como veio (string continua string) e leva fonte e estado da cotação", () => {
    const out = priceTrade(
      trade({ side: "sell", quantity: "0.5" }),
      quote({ price: "31.337", source: "brapi", marketState: "closed" }),
    );
    expect(out.payload).toMatchObject({
      side: "sell",
      quantity: "0.5",
      priceSource: "brapi",
      marketState: "closed",
    });
  });

  it("quantidade fracionária: 0.5 × 31.337 → 15.67 (meio para cima)", () => {
    expect(priceTrade(trade({ quantity: "0.5" }), quote({ price: "31.337" })).valueBrl).toBe(
      "15.67",
    );
    expect(priceTrade(trade({ quantity: 0.5 }), quote({ price: "31.337" })).valueBrl).toBe("15.67");
  });

  it("exatamente na metade arredonda para cima: 3 × 10.005 = 30.015 → 30.02; 1.5 × 10.01 = 15.015 → 15.02", () => {
    expect(priceTrade(trade({ quantity: 3 }), quote({ price: "10.005" })).valueBrl).toBe("30.02");
    expect(priceTrade(trade({ quantity: "1.5" }), quote({ price: "10.01" })).valueBrl).toBe(
      "15.02",
    );
    // logo abaixo da metade não sobe
    expect(priceTrade(trade({ quantity: 3 }), quote({ price: "10.004999" })).valueBrl).toBe(
      "30.01",
    );
  });

  it("valueBrl e notionalBrl são sempre o mesmo valor, com 2 casas", () => {
    const out = priceTrade(trade({ quantity: 7 }), quote({ price: "3" }));
    expect(out.valueBrl).toBe("21.00");
    expect(out.payload["notionalBrl"]).toBe("21.00");
  });

  it("decimal exato: sem perda por `number` nem arredondamento duplo pela precisão do Decimal", () => {
    // Produto exato 9999999900.00499999995 (21 dígitos significativos): com a precisão padrão do
    // Decimal (20) ele viraria ...00.0050000000 e subiria para .01.
    expect(
      priceTrade(trade({ quantity: "0.99999999" }), quote({ price: "10000000000.005" })).valueBrl,
    ).toBe("9999999900.00");
    // Quantidade fracionária grande (17 dígitos significativos, além do que `number` guarda).
    // Exato: 123456789.12345678 × 12.345678 = 1524157765.43209965279684 → 1524157765.43.
    expect(
      priceTrade(trade({ quantity: "123456789.12345678" }), quote({ price: "12.345678" })).valueBrl,
    ).toBe("1524157765.43");
    // Na metade exata além da 2ª casa, com quantidade grande: 100000000.5 × 0.01 = 1000000.005 → .01
    expect(priceTrade(trade({ quantity: "100000000.5" }), quote({ price: "0.01" })).valueBrl).toBe(
      "1000000.01",
    );
  });

  it("descarta toda chave do modelo fora do formato da ordem (valor, preço e qualquer outra)", () => {
    const injected = {
      valueBrl: "1.00",
      value_brl: "1.00",
      Price: 1,
      price: "0.01",
      AMOUNT: 1,
      Amount: "1",
      unit_price_brl: "0.01",
      UnitPriceBrl: "0.01",
      PRICEBRL: "0.01",
      valor: 1,
      Value: 1,
      notionalBrl: "1.00",
      priceSource: "model",
      priceAsOf: "1999-01-01T00:00:00.000Z",
      marketState: "closed",
      foo: "bar",
      __proto__x: 1,
    };
    const out = priceTrade(trade(injected), quote());
    expect(Object.keys(out.payload).sort()).toEqual(
      [
        "assetCode",
        "marketState",
        "notionalBrl",
        "priceAsOf",
        "priceSource",
        "quantity",
        "side",
        "unitPriceBrl",
      ].sort(),
    );
    expect(out.payload).toMatchObject({
      unitPriceBrl: "30.00",
      notionalBrl: "3000.00",
      priceSource: "mock",
      priceAsOf: "2026-11-14T13:00:00.000Z",
      marketState: "open",
    });
    expect(out.valueBrl).toBe("3000.00");
  });

  it("nenhuma chave de valor ou de preço do billing sobrevive, em qualquer caixa", () => {
    const injected: Record<string, unknown> = {};
    for (const key of MODEL_VALUE_KEYS) {
      injected[key] = "1.00";
      injected[key.toUpperCase()] = "1.00";
      injected[key.toLowerCase()] = "1.00";
    }
    const keys = Object.keys(priceTrade(trade(injected), quote()).payload);
    const lowered = new Set(keys.map((k) => k.toLowerCase()));
    for (const key of MODEL_VALUE_KEYS) {
      if (key === "unitPriceBrl") continue; // é do servidor (verificado acima com o preço da cotação)
      expect(lowered.has(key.toLowerCase())).toBe(false);
    }
    expect(keys.filter((k) => k.toLowerCase() === "unitpricebrl")).toEqual(["unitPriceBrl"]);
  });

  it("notional acima de numeric(18,2): 1 000 000 000 × preço de 12 dígitos inteiros → price_unavailable", () => {
    expectPriceUnavailable(() =>
      priceTrade(trade({ quantity: 1_000_000_000 }), quote({ price: "999999999999.999999" })),
    );
    expectPriceUnavailable(() =>
      priceTrade(trade({ quantity: "1000000000" }), quote({ price: "100000000000" })),
    );
  });

  it("aceita exatamente o maior notional que cabe (MAX_MONEY_BRL) e recusa o que passa dele", () => {
    // 10 000 × 999 999 999 999.999999 = 9 999 999 999 999 999.99 (o máximo de numeric(18,2))
    expect(
      priceTrade(trade({ quantity: 10_000 }), quote({ price: "999999999999.999999" })).valueBrl,
    ).toBe("9999999999999999.99");
    // um fio acima: 10 000.00000001 × o mesmo preço ≈ 9 999 999 999 999 999.99 + 0.01
    expectPriceUnavailable(() =>
      priceTrade(trade({ quantity: "10000.00000001" }), quote({ price: "999999999999.999999" })),
    );
  });

  it("quantidade inválida → price_unavailable", () => {
    for (const quantity of [
      0,
      -1,
      "0",
      "-1",
      "abc",
      "1e3",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1_000_000_001,
      "1000000001",
      null,
      undefined,
      true,
      {},
    ]) {
      expectPriceUnavailable(() => priceTrade(trade({ quantity }), quote()));
    }
  });

  it("payload fora do formato (lado, código do ativo) → price_unavailable", () => {
    expectPriceUnavailable(() => priceTrade(trade({ side: "hold" }), quote()));
    expectPriceUnavailable(() => priceTrade(trade({ assetCode: "petr4" }), quote()));
    expectPriceUnavailable(() => priceTrade({ quantity: 1 }, quote()));
  });

  it("preço zero, negativo ou fora do formato nunca vira ordem", () => {
    for (const price of ["0", "0.00", "-30.00", "abc", "", "1e3", "NaN", "Infinity"]) {
      expectPriceUnavailable(() => priceTrade(trade(), quote({ price })));
    }
  });

  it("notional que arredonda para 0.00 → price_unavailable", () => {
    expectPriceUnavailable(() =>
      priceTrade(trade({ quantity: "0.00000001" }), quote({ price: "0.01" })),
    );
    // 0.5 × 0.01 = 0.005 → 0.01 (meio para cima): ainda é ordem
    expect(priceTrade(trade({ quantity: "0.5" }), quote({ price: "0.01" })).valueBrl).toBe("0.01");
  });
});
