/**
 * Backtest determinístico sobre barras diárias do mercado.
 *
 * Port de `legacy/python/carina/builder/backtest.py`: sem aleatoriedade e sem lookahead (a posição
 * do dia `t` usa o sinal calculado com dados até `t-1`). Métricas em base 100 (equity inicial).
 *
 * Decisão deliberada: o SINAL do `sma_cross` é exato, em aritmética inteira (BigInt) sobre as
 * strings decimais de preço, e não em float. Janelas planas ou empatadas dão SMAs matematicamente
 * iguais, e a soma em float do Python varia por versão (3.12+ usa soma compensada, 3.11 não), o que
 * invertia `fast > slow` e mudava trocas e equity. Aqui um empate matemático é SEMPRE "fora da
 * posição", de forma determinística. Retornos, equity, drawdown e volatilidade seguem em float, com
 * paridade numérica com o Python (após arredondamento): a volatilidade pode diferir no último ulp em
 * entradas extremas, o que o arredondamento a 4 casas absorve.
 */
import type { BacktestResult, HistoricalBar, HistoryRange, StrategyKind } from "@carina/shared";
import { round4 } from "../../core/math/round4.js";
import { ValidationError } from "../../core/errors/domain-errors.js";

const TRADING_DAYS_PER_YEAR = 252;

export interface BacktestInput {
  kind: StrategyKind;
  symbol: string;
  bars: HistoricalBar[];
  fast: number;
  slow: number;
}

/**
 * Máximo de pregões da B3 que cada `range` do provedor pode conter (teto, não o valor típico).
 * Serve à pré-checagem barata do controller, antes de gastar uma chamada do orçamento do provedor.
 */
export const MAX_BARS_PER_RANGE: Readonly<Record<HistoryRange, number>> = {
  "5d": 5,
  "1mo": 23,
  "3mo": 66,
  "6mo": 130,
  "1y": 253,
  "2y": 506,
  "5y": 1265,
};

/** Barras mínimas que a estratégia exige (2 para `buy_hold`, `slow + 1` para `sma_cross`). */
export function minimumBars(kind: StrategyKind, slow: number): number {
  return kind === "buy_hold" ? 2 : slow + 1;
}

/**
 * Recusa SEM buscar histórico um `range` que não comporta as barras que a estratégia exige.
 *
 * @throws ValidationError (422), com mensagem fixa só com o intervalo e as contagens.
 */
export function assertRangeFits(kind: StrategyKind, slow: number, range: HistoryRange): void {
  const minimum = minimumBars(kind, slow);
  const capacity = MAX_BARS_PER_RANGE[range];
  if (capacity < minimum) {
    throw new ValidationError(
      `Intervalo curto demais para '${kind}': '${range}' comporta até ${String(capacity)} barras (mínimo ${String(minimum)})`,
    );
  }
}

/** Casas decimais máximas de `PriceSchema` (até 6): todo preço vira inteiro escalado por 10^6. */
const PRICE_DECIMALS = 6;

/** "12.5" → 12500000n, exato (sem passar por float). */
function toScaled(price: string): bigint {
  const [intPart = "0", frac = ""] = price.split(".");
  return BigInt(intPart + frac.padEnd(PRICE_DECIMALS, "0").slice(0, PRICE_DECIMALS));
}

/** Sinal por barra (`true` = comprado), usando dados ATÉ a própria barra, com decisão exata. */
function signals(kind: StrategyKind, scaled: bigint[], fast: number, slow: number): boolean[] {
  if (kind === "buy_hold") return scaled.map(() => true);
  // Soma acumulada: prefix[i] = soma das i primeiras barras (janela = diferença de dois prefixos).
  const prefix: bigint[] = [0n];
  for (const v of scaled) prefix.push((prefix[prefix.length - 1] ?? 0n) + v);
  const windowSum = (end: number, window: number): bigint =>
    (prefix[end] ?? 0n) - (prefix[end - window] ?? 0n);
  return scaled.map((_, t) => {
    const end = t + 1;
    if (end < fast || end < slow) return false;
    // média rápida > média lenta  <=>  fastSum * slow > slowSum * fast (empate → fora)
    return windowSum(end, fast) * BigInt(slow) > windowSum(end, slow) * BigInt(fast);
  });
}

/** Desvio-padrão populacional (dois passos: média, depois variância). */
function pstdev(values: number[]): number {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Roda o backtest de uma especificação sobre barras diárias em ordem cronológica.
 *
 * @throws ValidationError se o símbolo não tem histórico, se o histórico é insuficiente para a estratégia ou se algum fechamento
 *   não é positivo (o `PriceSchema` aceita "0", que daria Infinity/NaN nos retornos).
 */
export function runBacktest(input: BacktestInput): Omit<BacktestResult, "usage"> {
  const { kind, symbol, bars, fast, slow } = input;
  if (bars.length === 0) throw new ValidationError("Símbolo sem histórico no provedor");
  const minimum = minimumBars(kind, slow);
  if (bars.length < minimum) {
    throw new ValidationError(
      `Histórico insuficiente para '${kind}': ${String(bars.length)} barras (mínimo ${String(minimum)})`,
    );
  }

  const first = bars[0];
  const last = bars[bars.length - 1];
  if (!first || !last) throw new ValidationError("Histórico vazio");

  const closes = bars.map((b) => Number(b.close));
  // Mensagem fixa só com a contagem de barras afetadas: nunca ecoa preços.
  const nonPositive = closes.filter((c) => !(c > 0)).length;
  if (nonPositive > 0) {
    throw new ValidationError(`Fechamento não positivo em ${String(nonPositive)} barras`);
  }
  const flags = signals(
    kind,
    bars.map((b) => toScaled(b.close)),
    fast,
    slow,
  );

  let equity = 100;
  let peak = equity;
  let maxDrawdown = 0;
  let trades = 0;
  let inPosition = false;
  const dailyReturns: number[] = [];
  const curve: number[] = [equity];

  for (let t = 1; t < closes.length; t++) {
    const position = flags[t - 1] ?? false; // sem lookahead: o sinal de ontem decide hoje
    if (position !== inPosition) {
      trades += 1;
      inPosition = position;
    }
    const assetReturn = (closes[t] ?? 0) / (closes[t - 1] ?? 1) - 1;
    const strategyReturn = position ? assetReturn : 0;
    dailyReturns.push(strategyReturn);
    equity *= 1 + strategyReturn;
    curve.push(round4(equity));
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }

  const volatility =
    dailyReturns.length > 1 ? pstdev(dailyReturns) * Math.sqrt(TRADING_DAYS_PER_YEAR) : 0;

  return {
    symbol,
    kind,
    bars: bars.length,
    start: first.date,
    end: last.date,
    totalReturnPct: round4((equity / 100 - 1) * 100),
    maxDrawdownPct: round4(maxDrawdown * 100),
    annualizedVolatilityPct: round4(volatility * 100),
    trades,
    finalEquity: round4(equity),
    equityCurve: curve,
  };
}
