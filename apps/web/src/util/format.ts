import { MoneySchema, PriceSchema, SignedDecimalSchema } from "@carina/shared";

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const monthLong = new Intl.DateTimeFormat("pt-BR", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const percent = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });

/**
 * Dinheiro vem como string decimal (`"7.50"`). Só formata: `Intl.NumberFormat` aceita a string
 * decimal sem passar por `number`, então valores grandes não perdem precisão.
 */
export function formatBrl(money: string): string {
  if (!MoneySchema.safeParse(money).success) return "—";
  return brl.format(money as `${number}`);
}

/** Soma exata em centavos (BigInt): nada de ponto flutuante em aritmética de dinheiro. */
export function sumMoney(values: readonly string[]): string {
  let cents = 0n;
  for (const value of values) {
    if (!MoneySchema.safeParse(value).success) continue;
    const negative = value.startsWith("-");
    const [whole = "0", frac = ""] = value.replace("-", "").split(".");
    const abs = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
    cents += negative ? -abs : abs;
  }
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const text = `${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : dateTime.format(date);
}

/** `YYYY-MM` → "novembro de 2026". */
export function formatMonth(month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? month : monthLong.format(date);
}

export function formatNumber(value: number): string {
  return percent.format(value);
}

const variation = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * Cotação (string decimal, até 6 casas) em R$, arredondada para centavos só na exibição.
 * `formatBrl` não serve: ele só aceita dinheiro com no máximo 2 casas.
 */
export function formatPrice(price: string): string {
  if (!PriceSchema.safeParse(price).success) return "—";
  return brl.format(price as `${number}`);
}

/** Variação percentual em valor absoluto, uma casa e vírgula ("-6.24" vira "6,2"); o sinal vai no texto. */
export function formatVariationPct(changePct: string): string {
  if (!SignedDecimalSchema.safeParse(changePct).success) return "—";
  return variation.format(changePct.replace(/^-/, "") as `${number}`);
}

const saoPauloDay = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Data de São Paulo (`YYYY-MM-DD`) no instante `ms`: o mesmo dia de pregão do monitor. */
export function saoPauloDate(ms: number): string {
  const parts = saoPauloDay.formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** `YYYY-MM-DD` → "DD/MM", direto da string (sem `Date` nem fuso); fora do formato → "—". */
export function formatDayMonth(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${m[2] ?? ""}/${m[1] ?? ""}` : "—";
}
