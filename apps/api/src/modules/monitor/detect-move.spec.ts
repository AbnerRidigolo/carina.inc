import type { Quote } from "@carina/shared";
import { describe, expect, it } from "vitest";
import { detectMove } from "./detect-move.js";

const quote = (over: Partial<Quote> = {}): Quote => ({
  symbol: "PETR4",
  name: "Petrobras PN",
  assetClass: "stock",
  price: "31.40",
  changePct: "-6.2",
  previousClose: "33.47",
  volume: "1000",
  currency: "BRL",
  updatedAt: "2026-11-21T15:00:00.000Z",
  marketState: "open",
  source: "mock",
  ...over,
});

describe("detectMove", () => {
  it("5,00% e −5,00% alertam (limite inclusivo)", () => {
    expect(detectMove(quote({ changePct: "5.00" }), 5, "mock")).toEqual({
      direction: "up",
      changePct: "5.00",
      price: "31.40",
    });
    expect(detectMove(quote({ changePct: "-5.00" }), 5, "mock")).toEqual({
      direction: "down",
      changePct: "-5.00",
      price: "31.40",
    });
    expect(detectMove(quote({ changePct: "5" }), 5, "mock")?.direction).toBe("up");
    expect(detectMove(quote({ changePct: "-12.345678" }), 5, "mock")?.direction).toBe("down");
    // modo live espera source brapi
    expect(detectMove(quote({ changePct: "7.1", source: "brapi" }), 5, "live")).toEqual({
      direction: "up",
      changePct: "7.1",
      price: "31.40",
    });
  });

  it("4,99% não alerta", () => {
    expect(detectMove(quote({ changePct: "4.99" }), 5, "mock")).toBeNull();
    expect(detectMove(quote({ changePct: "-4.99" }), 5, "mock")).toBeNull();
    expect(detectMove(quote({ changePct: "4.999999" }), 5, "mock")).toBeNull();
    expect(detectMove(quote({ changePct: "0" }), 5, "mock")).toBeNull();
    expect(detectMove(quote({ changePct: "-0.000001" }), 1, "mock")).toBeNull();
  });

  it("changePct nulo, mercado fechado ou source de outro modo → null", () => {
    expect(detectMove(quote({ changePct: null }), 5, "mock")).toBeNull();
    expect(detectMove(quote({ marketState: "closed" }), 5, "mock")).toBeNull();
    expect(detectMove(quote({ source: "brapi" }), 5, "mock")).toBeNull();
    expect(detectMove(quote({ source: "mock" }), 5, "live")).toBeNull();
  });

  it("variação absurda (|changePct| que não cabe em numeric(9,4)) → null", () => {
    // ex.: desdobramento não ajustado pelo provedor; o insert estouraria a coluna
    expect(detectMove(quote({ changePct: "100000" }), 5, "mock")).toBeNull();
    expect(detectMove(quote({ changePct: "-100000" }), 5, "mock")).toBeNull();
    expect(detectMove(quote({ changePct: "250000.5" }), 5, "mock")).toBeNull();
    // arredondado a 4 casas pelo banco viraria 100000.0000
    expect(detectMove(quote({ changePct: "99999.99995" }), 5, "mock")).toBeNull();
    expect(detectMove(quote({ changePct: "-99999.99995" }), 5, "mock")).toBeNull();
    // o maior que cabe ainda alerta
    expect(detectMove(quote({ changePct: "99999.9999" }), 5, "mock")?.direction).toBe("up");
    expect(detectMove(quote({ changePct: "-99999.99994" }), 5, "mock")?.direction).toBe("down");
  });

  it("limite diferente do padrão vale nos dois sentidos", () => {
    expect(detectMove(quote({ changePct: "9.99" }), 10, "mock")).toBeNull();
    expect(detectMove(quote({ changePct: "-10" }), 10, "mock")?.direction).toBe("down");
    expect(detectMove(quote({ changePct: "1.000001" }), 1, "mock")?.direction).toBe("up");
  });
});
