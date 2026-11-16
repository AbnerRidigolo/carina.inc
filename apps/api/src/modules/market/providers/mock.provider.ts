import type { HistoricalBar, HistoryRange, MacroIndicator } from "@carina/shared";
import { mulberry32 } from "../../data-ingestion/synthetic/generator.js";
import type { Clock } from "../../limits/clock.js";
import { inferAssetClass } from "../asset-class.js";
import type { MacroProvider, MarketDataProvider, RawQuote } from "./types.js";

/** Tabela fixa da demo. PETR4 a R$ 30,00 mantém o roteiro em R$ 3.000,00 e R$ 90,00. */
export const MOCK_PRICES: Readonly<Record<string, string>> = {
  PETR4: "30.00",
  VALE3: "62.40",
  ITUB4: "34.10",
  BBDC4: "12.80",
  BBAS3: "27.60",
  MGLU3: "9.50",
  WEGE3: "51.80",
  PRIO3: "45.70",
  HGLG11: "162.00",
  KNRI11: "158.50",
  MXRF11: "10.40",
  XPML11: "107.80",
  IVVB11: "330.00",
  BOVA11: "125.00",
};

const MOCK_NAMES: Readonly<Record<string, string>> = {
  PETR4: "Petrobras PN",
  VALE3: "Vale ON",
  ITUB4: "Itaú Unibanco PN",
  BBDC4: "Bradesco PN",
  BBAS3: "Banco do Brasil ON",
  MGLU3: "Magazine Luiza ON",
  WEGE3: "WEG ON",
  PRIO3: "PRIO ON",
  HGLG11: "CSHG Logística FII",
  KNRI11: "Kinea Renda Imobiliária FII",
  MXRF11: "Maxi Renda FII",
  XPML11: "XP Malls FII",
  IVVB11: "iShares S&P 500 Fundo de Índice",
  BOVA11: "iShares Ibovespa Fundo de Índice",
};

/** Pregões por faixa (aproximação de dias úteis). */
const BARS_BY_RANGE: Readonly<Record<HistoryRange, number>> = {
  "5d": 5,
  "1mo": 21,
  "3mo": 63,
  "6mo": 126,
  "1y": 252,
  "2y": 504,
  "5y": 1260,
};

const DAY_MS = 86_400_000;

/** "30.00" -> 3000 (centavos inteiros, sem passar por ponto flutuante). */
function toCents(price: string): bigint {
  const [int = "0", frac = ""] = price.split(".");
  return BigInt(int) * 100n + BigInt(frac.padEnd(2, "0").slice(0, 2));
}

function formatCents(cents: bigint): string {
  const abs = cents < 0n ? -cents : cents;
  const text = `${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
  return cents < 0n ? `-${text}` : text;
}

/** Aplica uma variação em pontos-base (1 bp = 0,01%) sobre centavos, com piso de 1 centavo. */
function applyBps(cents: bigint, bps: bigint): bigint {
  const next = (cents * (10_000n + bps)) / 10_000n;
  return next < 1n ? 1n : next;
}

function seedFromSymbol(symbol: string): number {
  let h = 2166136261;
  for (let i = 0; i < symbol.length; i++) h = Math.imul(h ^ symbol.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Inteiro em [min, max] a partir do PRNG. */
function randInt(next: () => number, min: number, max: number): number {
  return min + Math.floor(next() * (max - min + 1));
}

/** Dias úteis (seg a sex, UTC) terminando em `endMs`, do mais antigo ao mais recente. */
function tradingDates(endMs: number, count: number): string[] {
  const dates: string[] = [];
  let cursor = new Date(endMs);
  cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate()));
  while (dates.length < count) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  return dates.reverse();
}

export class MockMarketProvider implements MarketDataProvider, MacroProvider {
  constructor(private readonly clock: Clock) {}

  fetchQuotes(symbols: string[]): Promise<RawQuote[]> {
    const updatedAt = new Date(this.clock()).toISOString();
    const quotes: RawQuote[] = [];
    for (const symbol of symbols) {
      const price = MOCK_PRICES[symbol];
      if (price === undefined) continue;
      const next = mulberry32(seedFromSymbol(`${symbol}:quote`));
      const bps = BigInt(randInt(next, -150, 150));
      const cents = toCents(price);
      const previous = (cents * 10_000n) / (10_000n + bps);
      const diff = cents - previous;
      const pctBps = previous === 0n ? 0n : (diff * 10_000n) / previous;
      quotes.push({
        symbol,
        name: MOCK_NAMES[symbol] ?? symbol,
        assetClass: inferAssetClass(symbol),
        price,
        changePct: formatCents(pctBps),
        previousClose: formatCents(previous),
        volume: String(randInt(next, 100_000, 9_000_000)),
        currency: "BRL",
        updatedAt,
        source: "mock",
      });
    }
    return Promise.resolve(quotes);
  }

  fetchHistory(symbol: string, range: HistoryRange): Promise<HistoricalBar[]> {
    const price = MOCK_PRICES[symbol];
    if (price === undefined) return Promise.resolve([]);
    const count = BARS_BY_RANGE[range];
    const dates = tradingDates(this.clock(), count);
    const next = mulberry32(seedFromSymbol(symbol));

    // Passeio aleatório de trás para frente: o último fechamento é o preço da tabela.
    const closes: bigint[] = new Array<bigint>(count);
    closes[count - 1] = toCents(price);
    for (let i = count - 1; i > 0; i--) {
      closes[i - 1] = applyBps(closes[i] as bigint, BigInt(randInt(next, -200, 200)));
    }

    const bars: HistoricalBar[] = dates.map((date, i) => {
      const close = closes[i] as bigint;
      const open = i === 0 ? close : (closes[i - 1] as bigint);
      const top = open > close ? open : close;
      const bottom = open > close ? close : open;
      const high = applyBps(top, BigInt(randInt(next, 0, 100)));
      const lowRaw = applyBps(bottom, -BigInt(randInt(next, 0, 100)));
      const low = lowRaw > bottom ? bottom : lowRaw;
      return {
        date,
        open: formatCents(open),
        high: formatCents(high),
        low: formatCents(low),
        close: formatCents(close),
        volume: String(randInt(next, 100_000, 9_000_000)),
      };
    });
    return Promise.resolve(bars);
  }

  fetchMacro(): Promise<MacroIndicator[]> {
    const referenceDate = new Date(this.clock()).toISOString().slice(0, 10);
    return Promise.resolve([
      { code: "selic", name: "Selic", value: "14.75", unit: "% a.a.", referenceDate },
      { code: "cdi", name: "CDI", value: "14.65", unit: "% a.a.", referenceDate },
      { code: "ipca", name: "IPCA", value: "0.52", unit: "% a.m.", referenceDate },
      { code: "ptax_usd", name: "PTAX dólar", value: "5.45", unit: "BRL", referenceDate },
    ]);
  }
}
