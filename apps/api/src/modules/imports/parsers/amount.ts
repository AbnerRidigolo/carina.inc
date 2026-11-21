import type { CsvMapping } from "@carina/shared";
import type { RowErrorCode } from "./row-errors.js";

export type Amount = { sign: 1 | -1; abs: string } | { error: RowErrorCode };

/**
 * Valor monetário com o separador decimal do mapeamento. Aceita milhar no outro separador,
 * `R$` e sinal; recusa como ambíguo `X,ddd` no fim (ou `.ddd` em `dot`) e separadores em ordem errada.
 */
export function parseAmount(raw: string, decimal: CsvMapping["decimal"]): Amount {
  const cleaned = raw.replace(/R\$/gi, "").replace(/\s/g, "");
  const m = /^([+-])?(.*)$/.exec(cleaned);
  const body = m?.[2] ?? "";
  const [dec, thou] = decimal === "comma" ? [",", "."] : [".", ","];
  const lastDec = body.lastIndexOf(dec);
  const wrongOrder = lastDec >= 0 && body.slice(lastDec).includes(thou);
  const threeAtEnd = new RegExp(`\\${dec}\\d{3}$`).test(body);
  if (/^[\d.,]+$/.test(body) && (wrongOrder || threeAtEnd)) return { error: "ambiguous_amount" };
  const valid = new RegExp(`^(?:\\d{1,3}(?:\\${thou}\\d{3})+|\\d+)(?:\\${dec}\\d{1,2})?$`);
  if (!valid.test(body)) return { error: "invalid_amount" };
  const [int = "", frac = ""] = body.replaceAll(thou, "").split(dec);
  if (int.length > 16) return { error: "invalid_amount" };
  const abs = `${int.replace(/^0+(?=\d)/, "")}.${frac.padEnd(2, "0")}`;
  if (/^0+\.00$/.test(abs)) return { error: "invalid_amount" };
  return { sign: m?.[1] === "-" ? -1 : 1, abs };
}
