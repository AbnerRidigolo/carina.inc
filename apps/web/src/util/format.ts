import { MoneySchema } from "@carina/shared";

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
