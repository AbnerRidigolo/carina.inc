import type { Quote } from "@carina/shared";
import { describe, expect, it } from "vitest";
import { type MonitorMode, detectMove } from "./detect-move.js";

/** 2026-11-16 (segunda) às 15:00 em São Paulo: pregão aberto. */
const NOW = Date.parse("2026-11-16T18:00:00.000Z");
const TODAY = "2026-11-16";
const MAX_AGE = 300_000;

const quote = (over: Partial<Quote> = {}): Quote => ({
  symbol: "PETR4",
  name: "Petrobras PN",
  assetClass: "stock",
  price: "31.40",
  changePct: "-6.2",
  previousClose: "33.47",
  volume: "1000",
  currency: "BRL",
  updatedAt: "2026-11-16T17:59:00.000Z",
  marketState: "open",
  source: "mock",
  ...over,
});

/** Regra com o relógio e o dia de pregão fixos (sobrescrevíveis). */
const detect = (
  q: Quote,
  thresholdPct: number,
  mode: MonitorMode,
  over: { nowMs?: number; tradingDay?: string; maxAgeMs?: number } = {},
) =>
  detectMove(q, {
    thresholdPct,
    mode,
    nowMs: over.nowMs ?? NOW,
    tradingDay: over.tradingDay ?? TODAY,
    maxAgeMs: over.maxAgeMs ?? MAX_AGE,
  });

describe("detectMove", () => {
  it("5,00% e −5,00% alertam (limite inclusivo)", () => {
    expect(detect(quote({ changePct: "5.00" }), 5, "mock")).toEqual({
      direction: "up",
      changePct: "5.00",
      price: "31.40",
    });
    expect(detect(quote({ changePct: "-5.00" }), 5, "mock")).toEqual({
      direction: "down",
      changePct: "-5.00",
      price: "31.40",
    });
    expect(detect(quote({ changePct: "5" }), 5, "mock")?.direction).toBe("up");
    expect(detect(quote({ changePct: "-12.345678" }), 5, "mock")?.direction).toBe("down");
    // modo live espera source brapi
    expect(detect(quote({ changePct: "7.1", source: "brapi" }), 5, "live")).toEqual({
      direction: "up",
      changePct: "7.1",
      price: "31.40",
    });
  });

  it("4,99% não alerta", () => {
    expect(detect(quote({ changePct: "4.99" }), 5, "mock")).toBeNull();
    expect(detect(quote({ changePct: "-4.99" }), 5, "mock")).toBeNull();
    expect(detect(quote({ changePct: "4.999999" }), 5, "mock")).toBeNull();
    expect(detect(quote({ changePct: "0" }), 5, "mock")).toBeNull();
    expect(detect(quote({ changePct: "-0.000001" }), 1, "mock")).toBeNull();
  });

  it("changePct nulo ou source de outro modo → null", () => {
    expect(detect(quote({ changePct: null }), 5, "mock")).toBeNull();
    expect(detect(quote({ source: "brapi" }), 5, "mock")).toBeNull();
    expect(detect(quote({ source: "mock" }), 5, "live")).toBeNull();
  });

  it("variação absurda (|changePct| que não cabe em numeric(9,4)) → null", () => {
    // ex.: desdobramento não ajustado pelo provedor; o insert estouraria a coluna
    expect(detect(quote({ changePct: "100000" }), 5, "mock")).toBeNull();
    expect(detect(quote({ changePct: "-100000" }), 5, "mock")).toBeNull();
    expect(detect(quote({ changePct: "250000.5" }), 5, "mock")).toBeNull();
    // arredondado a 4 casas pelo banco viraria 100000.0000
    expect(detect(quote({ changePct: "99999.99995" }), 5, "mock")).toBeNull();
    expect(detect(quote({ changePct: "-99999.99995" }), 5, "mock")).toBeNull();
    // o maior que cabe ainda alerta
    expect(detect(quote({ changePct: "99999.9999" }), 5, "mock")?.direction).toBe("up");
    expect(detect(quote({ changePct: "-99999.99994" }), 5, "mock")?.direction).toBe("down");
  });

  it("limite diferente do padrão vale nos dois sentidos", () => {
    expect(detect(quote({ changePct: "9.99" }), 10, "mock")).toBeNull();
    expect(detect(quote({ changePct: "-10" }), 10, "mock")?.direction).toBe("down");
    expect(detect(quote({ changePct: "1.000001" }), 1, "mock")?.direction).toBe("up");
  });

  it("cotação do pregão anterior não alerta", () => {
    // sexta 13/11 às 17:59 em SP: dia anterior ao pregão de hoje, mesmo com idade dentro do limite
    const yesterday = quote({ updatedAt: "2026-11-13T20:59:00.000Z" });
    expect(detect(yesterday, 5, "mock", { maxAgeMs: 7 * 86_400_000 })).toBeNull();
    // 23:59 de ontem em SP (02:59Z de hoje) também é de outro dia
    const lateNight = quote({ updatedAt: "2026-11-16T02:59:00.000Z" });
    expect(detect(lateNight, 5, "mock", { maxAgeMs: 86_400_000 })).toBeNull();
  });

  it("cotação mais velha que MARKET_QUOTE_MAX_AGE_MS não alerta", () => {
    // hoje às 10:00 em SP (13:00Z): 5 h antes do relógio, limite de 5 min
    expect(detect(quote({ updatedAt: "2026-11-16T13:00:00.000Z" }), 5, "mock")).toBeNull();
    // um milissegundo além do limite
    const edge = new Date(NOW - MAX_AGE - 1).toISOString();
    expect(detect(quote({ updatedAt: edge }), 5, "mock")).toBeNull();
    // hora futura ou ilegível também não vale
    expect(detect(quote({ updatedAt: new Date(NOW + 1000).toISOString() }), 5, "mock")).toBeNull();
    expect(detect(quote({ updatedAt: "ontem" }), 5, "mock")).toBeNull();
  });

  it("cotação de hoje e fresca alerta", () => {
    const atLimit = new Date(NOW - MAX_AGE).toISOString();
    expect(detect(quote({ updatedAt: atLimit }), 5, "mock")?.direction).toBe("down");
    expect(detect(quote({ updatedAt: new Date(NOW).toISOString() }), 5, "mock")).toEqual({
      direction: "down",
      changePct: "-6.2",
      price: "31.40",
    });
  });
});
