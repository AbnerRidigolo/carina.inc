import type { HistoricalBar, HistoryRange, MacroIndicator, Quote } from "@carina/shared";

/** Cotação como o provedor a entrega: o estado do mercado é calculado pelo serviço. */
export type RawQuote = Omit<Quote, "marketState">;

export interface MarketDataProvider {
  fetchQuotes(symbols: string[]): Promise<RawQuote[]>;
  fetchHistory(symbol: string, range: HistoryRange): Promise<HistoricalBar[]>;
}

export interface MacroProvider {
  fetchMacro(): Promise<MacroIndicator[]>;
}
