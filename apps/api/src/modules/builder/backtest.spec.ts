import type { HistoricalBar } from "@carina/shared";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../../core/errors/domain-errors.js";
import { runBacktest } from "./backtest.js";

/** Barras diárias a partir de 2026-01-01; só o fechamento importa para o motor. */
function bars(closes: number[]): HistoricalBar[] {
  return closes.map((c, i) => {
    const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    const p = String(c);
    return { date: day, open: p, high: p, low: p, close: p, volume: "100" };
  });
}

const buyHold = (closes: number[]) =>
  runBacktest({ kind: "buy_hold", symbol: "PETR4", bars: bars(closes), fast: 10, slow: 50 });
const smaCross = (closes: number[], fast: number, slow: number) =>
  runBacktest({ kind: "sma_cross", symbol: "PETR4", bars: bars(closes), fast, slow });

describe("runBacktest: buy_hold", () => {
  it("em alta monotônica rende o retorno do ativo, sem drawdown e com entrada única", () => {
    const r = buyHold([100, 110, 121]);
    expect(r.totalReturnPct).toBeCloseTo(21, 9);
    expect(r.maxDrawdownPct).toBe(0);
    expect(r.trades).toBe(1);
    expect(r.finalEquity).toBeCloseTo(121, 9);
    expect(r.equityCurve[0]).toBe(100);
    expect(r.equityCurve).toHaveLength(3);
  });

  it("mede o drawdown do pico ao vale", () => {
    // Pico em 120, vale em 90: queda de 25%.
    expect(buyHold([100, 120, 90, 100]).maxDrawdownPct).toBeCloseTo(25, 9);
  });

  it("devolve símbolo, tipo, contagem de barras e as datas da primeira e da última", () => {
    const r = buyHold([100, 110, 121]);
    expect(r).toMatchObject({
      symbol: "PETR4",
      kind: "buy_hold",
      bars: 3,
      start: "2026-01-01",
      end: "2026-01-03",
    });
    expect(r).not.toHaveProperty("usage");
  });
});

describe("runBacktest: sma_cross", () => {
  it("sai da posição na virada e perde menos que segurar até o fim", () => {
    // Sobe e desaba: a média rápida cruza para baixo e a estratégia vai a caixa.
    const closes = [100, 102, 104, 106, 108, 110, 70, 50, 40, 30, 20, 10];
    const r = smaCross(closes, 2, 4);
    expect(r.trades).toBeGreaterThanOrEqual(2);
    expect(r.finalEquity).toBeGreaterThan(buyHold(closes).finalEquity);
  });

  it("não tem lookahead no primeiro dia de sinal", () => {
    // O sinal só nasce na 5ª barra (índice 4), junto do salto; o salto seria capturado
    // apenas se o sinal de HOJE decidisse a posição de hoje. Não pode ser.
    const r = smaCross([100, 100, 100, 100, 150], 2, 4);
    expect(r.totalReturnPct).toBe(0);
    expect(r.trades).toBe(0);
  });

  it("a posição do dia t usa o sinal de t-1 (captura o dia seguinte ao sinal)", () => {
    // Sinal liga em t=3 (fast 105 > slow 102,5); a posição vale em t=4: retorno de 110/105-1.
    const r = smaCross([100, 100, 100, 110, 121], 2, 4);
    expect(r.trades).toBe(1);
    expect(r.finalEquity).toBeCloseTo(110, 9);
  });
});

describe("runBacktest: histórico insuficiente", () => {
  it("falha explicitamente, com a contagem de barras e o mínimo", () => {
    const run = () => smaCross([1, 2, 3], 2, 10);
    expect(run).toThrow(ValidationError);
    expect(run).toThrow("Histórico insuficiente para 'sma_cross': 3 barras (mínimo 11)");
  });

  it("símbolo sem barras: mensagem própria, ainda ValidationError (422)", () => {
    const run = () => buyHold([]);
    expect(run).toThrow(ValidationError);
    expect(run).toThrow("Símbolo sem histórico no provedor");
  });

  it("buy_hold exige ao menos 2 barras", () => {
    expect(() => buyHold([100])).toThrow(
      "Histórico insuficiente para 'buy_hold': 1 barras (mínimo 2)",
    );
    expect(buyHold([100, 101]).bars).toBe(2);
  });
});

describe("runBacktest: fechamento não positivo", () => {
  it("fechamento zero recusa o backtest", () => {
    // "0" passa no PriceSchema, mas dividiria por zero nos retornos (Infinity/NaN).
    const run = () => buyHold([100, 0, 101, 0]);
    expect(run).toThrow(ValidationError);
    // Mensagem fixa só com a contagem de barras afetadas, sem preços.
    expect(run).toThrow("Fechamento não positivo em 2 barras");
  });

  it("vale também para o sma_cross e para fechamento negativo", () => {
    const closes = [-1, ...Array.from({ length: 11 }, (_, i) => 10 + i)];
    expect(() => smaCross(closes, 2, 10)).toThrow("Fechamento não positivo em 1 barras");
  });
});

describe("runBacktest: empate exato no sma_cross", () => {
  // Esperados: motor Python com o SINAL exato (Fraction) e o resto em float, sobre séries geradas
  // por fuzz com platôs, onde a soma em float diverge da exata (Python 3.13 e TS flutuam diferente).
  it("série totalmente plana: SMAs iguais, empate = fora da posição (0 trocas, equity 100)", () => {
    const r = smaCross(Array<number>(18).fill(13.96), 3, 7);
    expect(r.trades).toBe(0);
    expect(r.finalEquity).toBe(100);
    expect(r.equityCurve).toEqual(Array<number>(18).fill(100));
  });

  it("platôs de preço: sinal exato liga e desliga nos empates (3 trocas), equity 100", () => {
    const closes = [
      24.72, 24.72, 24.72, 24.72, 24.92, 24.92, 24.92, 24.92, 24.92, 24.92, 24.92, 24.92, 25.02,
      25.02, 25.02, 25.02, 25.02, 25.02,
    ];
    const r = smaCross(closes, 3, 7);
    expect(r.trades).toBe(3); // a soma em float daria 1 troca e equity 100,4013
    expect(r.finalEquity).toBe(100);
    expect(r.totalReturnPct).toBe(0);
    expect(r.equityCurve).toEqual(Array<number>(18).fill(100));
  });
});

describe("runBacktest: volatilidade", () => {
  it("é 0 com menos de 2 retornos", () => {
    expect(buyHold([10, 12.5]).annualizedVolatilityPct).toBe(0);
  });
  it("usa o desvio-padrão populacional dos retornos diários × √252", () => {
    const r = buyHold([100, 110, 99]);
    const r1 = 0.1;
    const r2 = 99 / 110 - 1;
    const mean = (r1 + r2) / 2;
    const pstdev = Math.sqrt(((r1 - mean) ** 2 + (r2 - mean) ** 2) / 2);
    expect(r.annualizedVolatilityPct).toBeCloseTo(pstdev * Math.sqrt(252) * 100, 4);
  });
});

describe("runBacktest: determinismo", () => {
  it("o mesmo histórico dá sempre o mesmo resultado e não altera a entrada", () => {
    const input = bars([100, 103, 101, 107, 99, 104]);
    const snapshot = JSON.stringify(input);
    const a = runBacktest({ kind: "sma_cross", symbol: "X", bars: input, fast: 2, slow: 3 });
    const b = runBacktest({ kind: "sma_cross", symbol: "X", bars: input, fast: 2, slow: 3 });
    expect(a).toEqual(b);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

/**
 * Valores esperados gerados rodando o motor Python (`legacy/python/carina/builder/backtest.py`,
 * `run_backtest`) sobre estas séries fixas, com `python3 -I`. Preço em reais, barras diárias.
 */
const PARIDADE_PYTHON = [
  {
    nome: "alta_monotonica",
    kind: "buy_hold",
    closes: [100, 101.5, 103.2, 104.9, 106.1, 108, 109.4, 111.3, 112.8, 114.6],
    fast: 10,
    slow: 50,
    totalReturnPct: 14.6,
    maxDrawdownPct: 0.0,
    annualizedVolatilityPct: 3.2937,
    trades: 1,
    finalEquity: 114.6,
    equityCurve: [100.0, 101.5, 103.2, 104.9, 106.1, 108.0, 109.4, 111.3, 112.8, 114.6],
  },
  {
    nome: "drawdown",
    kind: "buy_hold",
    closes: [100, 108, 115, 120, 104, 92, 95, 101, 99, 107, 112],
    fast: 10,
    slow: 50,
    totalReturnPct: 12.0,
    maxDrawdownPct: 23.3333,
    annualizedVolatilityPct: 118.4684,
    trades: 1,
    finalEquity: 112.0,
    equityCurve: [100.0, 108.0, 115.0, 120.0, 104.0, 92.0, 95.0, 101.0, 99.0, 107.0, 112.0],
  },
  {
    nome: "cruzamento_simples",
    kind: "sma_cross",
    closes: [100, 102, 104, 106, 108, 110, 70, 50, 40, 30, 20, 10],
    fast: 2,
    slow: 4,
    totalReturnPct: -33.9623,
    maxDrawdownPct: 36.3636,
    annualizedVolatilityPct: 168.0369,
    trades: 2,
    finalEquity: 66.0377,
    equityCurve: [
      100.0, 100.0, 100.0, 100.0, 101.8868, 103.7736, 66.0377, 66.0377, 66.0377, 66.0377, 66.0377,
      66.0377,
    ],
  },
  {
    nome: "precos_planos",
    kind: "buy_hold",
    closes: [50, 50, 50, 50, 50, 50],
    fast: 10,
    slow: 50,
    totalReturnPct: 0.0,
    maxDrawdownPct: 0.0,
    annualizedVolatilityPct: 0.0,
    trades: 1,
    finalEquity: 100.0,
    equityCurve: [100.0, 100.0, 100.0, 100.0, 100.0, 100.0],
  },
  {
    nome: "duas_barras",
    kind: "buy_hold",
    closes: [10, 12.5],
    fast: 10,
    slow: 50,
    totalReturnPct: 25.0,
    maxDrawdownPct: 0.0,
    annualizedVolatilityPct: 0.0,
    trades: 1,
    finalEquity: 125.0,
    equityCurve: [100.0, 125.0],
  },
  {
    nome: "sma_varios_cruzamentos",
    kind: "sma_cross",
    closes: [
      10, 10.4, 10.9, 11.5, 11.2, 10.6, 10.1, 9.7, 9.9, 10.5, 11.3, 12.1, 11.8, 11.0, 10.2, 9.5,
      9.8, 10.7, 11.6, 12.4, 13.0, 12.2, 11.1,
    ],
    fast: 3,
    slow: 7,
    totalReturnPct: -19.5529,
    maxDrawdownPct: 24.8718,
    annualizedVolatilityPct: 65.5076,
    trades: 3,
    finalEquity: 80.4471,
    equityCurve: [
      100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 107.0796,
      104.4248, 97.3451, 90.2655, 84.0708, 84.0708, 84.0708, 84.0708, 89.8688, 94.2173, 88.4193,
      80.4471,
    ],
  },
] as const;

describe("runBacktest: paridade com o Python", () => {
  it.each(PARIDADE_PYTHON)("$nome: métricas e curva idênticas às do motor Python", (caso) => {
    const r = runBacktest({
      kind: caso.kind,
      symbol: "PETR4",
      bars: bars([...caso.closes]),
      fast: caso.fast,
      slow: caso.slow,
    });
    expect(r.totalReturnPct).toBe(caso.totalReturnPct);
    expect(r.maxDrawdownPct).toBe(caso.maxDrawdownPct);
    expect(r.annualizedVolatilityPct).toBe(caso.annualizedVolatilityPct);
    expect(r.trades).toBe(caso.trades);
    expect(r.finalEquity).toBe(caso.finalEquity);
    expect(r.equityCurve).toEqual(caso.equityCurve);
  });
});
