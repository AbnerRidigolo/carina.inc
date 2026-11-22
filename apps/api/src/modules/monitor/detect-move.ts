/**
 * Regra do monitor de carteira (spec §4.2): alerta quando a variação do dia, em módulo, atinge o
 * limite (inclusivo), com a cotação vinda do provedor do modo atual, com `changePct` presente e
 * FRESCA: `updatedAt` no mesmo dia de São Paulo que `tradingDay` e com idade (`nowMs − updatedAt`)
 * de 0 a `maxAgeMs` (`MARKET_QUOTE_MAX_AGE_MS`, a mesma regra do frescor do `priceFor` em pregão).
 * O `marketState` da cotação não entra: o `monitorQuotes` o preenche pelo relógio, não pela
 * cotação. Função pura: o relógio entra como argumento, sem I/O.
 *
 * A comparação é feita sobre a string decimal, em inteiros (milionésimos), nunca em `number`:
 * "4.999999" fica abaixo de 5 e "5.00" alcança 5 sem depender de arredondamento de ponto flutuante.
 *
 * Variação que não cabe na coluna `change_pct numeric(9,4)` (|valor| arredondado a 4 casas ≥ 100000,
 * ou seja, ≥ 99999,99995) é descartada: é falha do provedor (ex.: desdobramento não ajustado), e o
 * insert estouraria.
 */
import type { Quote } from "@carina/shared";
import { quoteAgeWithin, saoPauloDate } from "../market/market-hours.js";

export type MonitorMode = "live" | "mock";

export interface DetectedMove {
  direction: "up" | "down";
  /** a variação da cotação, como veio (string decimal com sinal) */
  changePct: string;
  /** o preço da cotação, como veio (string decimal) */
  price: string;
}

/** Mesmo mapeamento do MarketService: live só aceita brapi; mock só aceita mock. */
const SOURCE_OF_MODE: Readonly<Record<MonitorMode, Quote["source"]>> = {
  live: "brapi",
  mock: "mock",
};

const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d{1,6}))?$/;
const SCALE = 6;
/** Menor |variação| (em milionésimos) que, arredondada a 4 casas, estoura `numeric(9,4)`. */
const OVERFLOW_MICROS = 99_999_999_950n;

/** Valor absoluto em milionésimos; `null` se a string não é um decimal válido. */
function absMicros(value: string): bigint | null {
  const m = DECIMAL_RE.exec(value);
  if (m === null) return null;
  const int = m[2] ?? "0";
  const frac = (m[3] ?? "").padEnd(SCALE, "0");
  return BigInt(int) * 10n ** BigInt(SCALE) + BigInt(frac);
}

export interface MoveRule {
  thresholdPct: number;
  mode: MonitorMode;
  nowMs: number;
  tradingDay: string;
  maxAgeMs: number;
}

export function detectMove(quote: Quote, rule: MoveRule): DetectedMove | null {
  const { thresholdPct, mode } = rule;
  // Cotação de outro dia (pregão anterior, feriado, ativo sem negócio hoje) ou velha demais
  // (ex.: o atraso de ~30 min do plano gratuito da brapi) não vira alerta "de hoje".
  if (!quoteAgeWithin(quote.updatedAt, rule.nowMs, rule.maxAgeMs)) return null;
  if (saoPauloDate(Date.parse(quote.updatedAt)) !== rule.tradingDay) return null;
  if (quote.source !== SOURCE_OF_MODE[mode]) return null;
  if (quote.changePct === null) return null;
  const abs = absMicros(quote.changePct);
  if (abs === null || abs >= OVERFLOW_MICROS) return null;
  // O limite vem da env (inteiro de 1 a 50); arredondado a milionésimos por segurança.
  const limit = BigInt(Math.round(thresholdPct * 10 ** SCALE));
  if (abs < limit) return null;
  return {
    direction: quote.changePct.startsWith("-") ? "down" : "up",
    changePct: quote.changePct,
    price: quote.price,
  };
}
