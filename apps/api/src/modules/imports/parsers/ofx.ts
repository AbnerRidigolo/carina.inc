import { type NormalizedTransaction, NormalizedTransactionSchema } from "@carina/shared";
import { decodeText } from "./decode.js";
import { deriveExternalId, OccurrenceCounter } from "./external-id.js";
import { RowErrors, type RowErrorCode } from "./row-errors.js";
import { PARSE_LIMITS, type ParseResult } from "./types.js";

const EMPTY_STATS = { rowsRead: 0, positions: 0, transactions: 0, errorRows: 0, ignored: {} };

function failed(failure: NonNullable<ParseResult["failure"]>): ParseResult {
  return {
    positions: [],
    transactions: [],
    errors: [],
    stats: { ...EMPTY_STATS, ignored: {} },
    failure,
  };
}

/** Descobre a codificação pelo cabeçalho (os campos do cabeçalho são ASCII). */
function detectEncoding(bytes: Uint8Array): "utf-8" | "windows-1252" | undefined {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  const xml = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1]?.toLowerCase();
  if (xml !== undefined) {
    if (xml === "utf-8" || xml === "utf8") return "utf-8";
    if (xml === "windows-1252" || xml === "iso-8859-1" || xml === "latin1") return "windows-1252";
    return undefined;
  }
  const charset = /^CHARSET:\s*(\S+)/im.exec(head)?.[1]?.toUpperCase();
  if (charset === "1252" || charset === "WINDOWS-1252" || charset === "ISO-8859-1") {
    return "windows-1252";
  }
  if (charset === "UTF-8" || charset === "UTF8") return "utf-8";
  return undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeValue(value: string): string {
  return value
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, n: string) => ENTITIES[n] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

interface RawTrn {
  fields: Map<string, string>;
  bank: string | undefined;
  acct: string | undefined;
}

interface Scan {
  trns: RawTrn[];
  investment: boolean;
  org: string | undefined;
}

/**
 * Tokenizer próprio: tag abre, valor vai até o próximo `<`. Em SGML as folhas não fecham;
 * em XML fecham, e o fechamento de folha não casa com nada na pilha e é ignorado.
 */
function scan(text: string): Scan {
  const out: Scan = { trns: [], investment: false, org: undefined };
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z0-9._]+)\s*>([^<]*)/g;
  let bank: string | undefined;
  let acct: string | undefined;
  let current: RawTrn | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const closing = m[1] === "/";
    const name = (m[2] ?? "").toUpperCase();
    const value = unescapeValue(m[3] ?? "");
    if (closing) {
      const at = stack.lastIndexOf(name);
      if (at >= 0) stack.length = at;
      if (name === "STMTTRN") current = undefined;
      continue;
    }
    if (name === "INVSTMTMSGSRSV1") out.investment = true;
    if (value === "" && name !== "STMTTRN" && !isLeafLike(name)) {
      stack.push(name);
      continue;
    }
    if (name === "STMTTRN") {
      const inStatement = stack.includes("BANKMSGSRSV1") || stack.includes("CREDITCARDMSGSRSV1");
      stack.push(name);
      current = inStatement ? { fields: new Map(), bank, acct } : undefined;
      if (current) out.trns.push(current);
      continue;
    }
    if (current) {
      if (!current.fields.has(name)) current.fields.set(name, value);
      continue;
    }
    if (name === "BANKID") bank = value;
    else if (name === "ACCTID") acct = value;
    else if (name === "ORG" && out.org === undefined) out.org = value;
  }
  return out;
}

/** Folhas conhecidas que podem vir vazias; não abrem agregado. */
function isLeafLike(name: string): boolean {
  return ["MEMO", "NAME", "FITID", "TRNTYPE", "DTPOSTED", "TRNAMT", "CHECKNUM", "REFNUM"].includes(
    name,
  );
}

function parseDate(raw: string): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:\d{6}(?:\.\d{1,3})?)?(?:\[[^\]]*\])?$/.exec(raw);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return undefined;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

type Amount = { sign: 1 | -1; abs: string } | { error: RowErrorCode };

function parseAmount(raw: string): Amount {
  const m = /^([+-])?(\d+(?:[.,]\d*)*)$/.exec(raw.replace(/\s/g, ""));
  if (!m) return { error: "invalid_amount" };
  const body = m[2] ?? "";
  const seps = body.match(/[.,]/g) ?? [];
  if (seps.length > 1) return { error: "ambiguous_amount" };
  const [int = "", frac = ""] = body.split(/[.,]/);
  if (frac.length > 2 || int === "" || int.length > 16) return { error: "invalid_amount" };
  const abs = `${int.replace(/^0+(?=\d)/, "")}.${frac.padEnd(2, "0")}`;
  if (/^0+\.00$/.test(abs)) return { error: "invalid_amount" };
  return { sign: m[1] === "-" ? -1 : 1, abs };
}

export function parseOfx(bytes: Uint8Array): ParseResult {
  const text = decodeText(bytes, detectEncoding(bytes));
  const start = text.search(/<OFX[\s>]/i);
  if (start < 0) return failed("unreadable");

  const { trns, investment, org } = scan(text.slice(start));
  if (investment) return failed("unsupported_ofx_investment");
  if (trns.length > PARSE_LIMITS.maxRows) return failed("limit_exceeded");

  const errors = new RowErrors();
  const counter = new OccurrenceCounter();
  const transactions: NormalizedTransaction[] = [];

  trns.forEach((trn, index) => {
    const row = index + 1;
    const f = trn.fields;
    const rawDate = f.get("DTPOSTED");
    const rawAmount = f.get("TRNAMT");
    if (!rawDate) return errors.add(row, "missing_field", "DTPOSTED");
    if (!rawAmount) return errors.add(row, "missing_field", "TRNAMT");
    const description = f.get("MEMO") || f.get("NAME");
    if (!description) return errors.add(row, "missing_field", "MEMO");
    const date = parseDate(rawDate);
    if (!date) return errors.add(row, "invalid_date", "DTPOSTED");
    const amount = parseAmount(rawAmount);
    if ("error" in amount) return errors.add(row, amount.error, "TRNAMT");

    const bankId = trn.bank ?? "";
    const acctId = trn.acct ?? "";
    const fitid = f.get("FITID");
    const signed = `${amount.sign < 0 ? "-" : ""}${amount.abs}`;
    const derivedParts = [bankId, acctId, date, signed, description];
    const externalId = fitid
      ? deriveExternalId("ofx", [bankId, acctId, fitid], 0)
      : deriveExternalId("ofx", derivedParts, counter.next(derivedParts.join("\u001f")));

    const item = {
      externalId,
      institution: org || trn.bank || "OFX",
      account: acctId,
      date,
      description,
      amountBrl: amount.abs,
      kind: amount.sign > 0 ? "credit" : "debit",
    };
    const parsed = NormalizedTransactionSchema.safeParse(item);
    if (!parsed.success) return errors.add(row, "schema");
    transactions.push(parsed.data);
  });

  if (transactions.length === 0) {
    return {
      ...failed("no_valid_rows"),
      errors: errors.list(),
      stats: { ...EMPTY_STATS, rowsRead: trns.length, errorRows: errors.count(), ignored: {} },
    };
  }
  return {
    positions: [],
    transactions,
    errors: errors.list(),
    stats: {
      rowsRead: trns.length,
      positions: 0,
      transactions: transactions.length,
      errorRows: errors.count(),
      ignored: {},
    },
  };
}
