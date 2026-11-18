import {
  type CsvMapping,
  ExternalIdSchema,
  type NormalizedTransaction,
  NormalizedTransactionSchema,
} from "@carina/shared";
import { decodeText } from "./decode.js";
import { deriveExternalId, OccurrenceCounter } from "./external-id.js";
import { parseAmount } from "./amount.js";
import { RowErrors } from "./row-errors.js";
import { ImportLimitError, PARSE_LIMITS, type ParseResult } from "./types.js";

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

export interface CsvRecord {
  /** Número do registro físico (cabeçalho = 1); quebra dentro de aspas não conta. */
  line: number;
  fields: string[];
}

function utf8Units(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return code >= 0xd800 && code <= 0xdfff ? 2 : 3;
}

/**
 * Tokenizer RFC 4180 em streaming de caracteres: aspas, aspas dobradas e quebra de linha dentro
 * de aspas. Estoura `ImportLimitError` ao passar de 64 colunas ou 64 KB por registro.
 */
export function* records(text: string, delimiter: string): Generator<CsvRecord> {
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let atFieldStart = true;
  let bytes = 0;
  let line = 0;
  let pending = false;

  const pushField = (): void => {
    fields.push(field);
    if (fields.length > PARSE_LIMITS.maxColumns) throw new ImportLimitError();
    field = "";
    atFieldStart = true;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch !== "\n" && ch !== "\r") {
      bytes += utf8Units(ch.charCodeAt(0));
    } else if (quoted) {
      bytes += 1;
    }
    if (bytes > PARSE_LIMITS.maxLineBytes) throw new ImportLimitError();

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
          bytes += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      pending = true;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      pushField();
      line += 1;
      yield { line, fields };
      fields = [];
      bytes = 0;
      pending = false;
      continue;
    }
    pending = true;
    if (ch === delimiter) {
      pushField();
    } else if (ch === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
    } else {
      field += ch;
      atFieldStart = false;
    }
  }
  if (pending) {
    pushField();
    line += 1;
    yield { line, fields };
  }
}

/** Delimitador da primeira linha (fora de aspas): o mais frequente entre `;` e `,`. */
function detectDelimiter(text: string): string {
  let semi = 0;
  let comma = 0;
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch === ";") semi++;
    else if (!quoted && ch === ",") comma++;
  }
  return semi > comma ? ";" : ",";
}

const norm = (s: string): string => s.normalize("NFC").trim();

function parseDate(raw: string, format: CsvMapping["dateFormat"]): string | undefined {
  const m =
    format === "dd/MM/yyyy"
      ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw)
      : /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return undefined;
  const [y, mo, d] =
    format === "dd/MM/yyyy"
      ? [Number(m[3]), Number(m[2]), Number(m[1])]
      : [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return undefined;
  }
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const KINDS: Record<string, "debit" | "credit"> = {
  debit: "debit",
  credit: "credit",
  débito: "debit",
  crédito: "credit",
};

export function parseCsv(
  bytes: Uint8Array,
  opts: { mapping: CsvMapping; institution: string; account: string },
): ParseResult {
  const { mapping, institution, account } = opts;
  const text = decodeText(bytes);
  const delimiter = mapping.delimiter ?? detectDelimiter(text);
  const errors = new RowErrors();
  const counter = new OccurrenceCounter();
  const transactions: NormalizedTransaction[] = [];
  let rowsRead = 0;

  try {
    const deadline = Date.now() + PARSE_LIMITS.parseTimeoutMs;
    let header: Map<string, number> | undefined;
    let idx: Record<"date" | "amount" | "description", number> & {
      kind?: number;
      category?: number;
      externalId?: number;
    } = { date: -1, amount: -1, description: -1 };

    for (const rec of records(text, delimiter)) {
      if (header === undefined) {
        const columns = new Map<string, number>();
        header = columns;
        rec.fields.forEach((name, i) => {
          const key = norm(name);
          if (!columns.has(key)) columns.set(key, i);
        });
        const find = (name: string | undefined): number | undefined =>
          name === undefined ? undefined : columns.get(norm(name));
        const date = find(mapping.date);
        const amount = find(mapping.amount);
        const description = find(mapping.description);
        const kind = find(mapping.kind);
        const category = find(mapping.category);
        const externalId = find(mapping.externalId);
        const optionalMissing = [
          [mapping.kind, kind],
          [mapping.category, category],
          [mapping.externalId, externalId],
        ].some(([name, i]) => name !== undefined && i === undefined);
        if (date === undefined || amount === undefined || description === undefined) {
          return failed("unreadable");
        }
        if (optionalMissing) return failed("unreadable");
        idx = { date, amount, description, kind, category, externalId };
        continue;
      }

      if (rec.fields.length === 1 && rec.fields[0]?.trim() === "") continue;
      rowsRead += 1;
      if (rowsRead > PARSE_LIMITS.maxRows) throw new ImportLimitError();
      if (rowsRead % 1024 === 0 && Date.now() > deadline) throw new ImportLimitError();

      const row = rec.line;
      const cell = (i: number | undefined): string =>
        i === undefined ? "" : (rec.fields[i] ?? "").normalize("NFC").trim();

      const rawDate = cell(idx.date);
      const rawAmount = cell(idx.amount);
      const description = cell(idx.description);
      if (!rawDate) {
        errors.add(row, "missing_field", "date");
        continue;
      }
      if (!rawAmount) {
        errors.add(row, "missing_field", "amount");
        continue;
      }
      if (!description) {
        errors.add(row, "missing_field", "description");
        continue;
      }
      const date = parseDate(rawDate, mapping.dateFormat);
      if (!date) {
        errors.add(row, "invalid_date", "date");
        continue;
      }
      const amount = parseAmount(rawAmount, mapping.decimal);
      if ("error" in amount) {
        errors.add(row, amount.error, "amount");
        continue;
      }

      let kind: "debit" | "credit" = amount.sign > 0 ? "credit" : "debit";
      if (idx.kind !== undefined) {
        const declared = KINDS[cell(idx.kind).toLowerCase()];
        if (declared === undefined) {
          errors.add(row, cell(idx.kind) ? "unknown_kind" : "missing_field", "kind");
          continue;
        }
        kind = declared;
      }

      const signed = `${kind === "debit" ? "-" : ""}${amount.abs}`;
      let externalId: string;
      if (idx.externalId !== undefined) {
        const own = cell(idx.externalId);
        if (!own) {
          errors.add(row, "missing_field", "externalId");
          continue;
        }
        if (!ExternalIdSchema.safeParse(own).success) {
          errors.add(row, "schema", "externalId");
          continue;
        }
        externalId = own;
      } else {
        const parts = [institution, account, date, signed, description];
        externalId = deriveExternalId("csv", parts, counter.next(parts.join("\u001f")));
      }

      const category = cell(idx.category);
      const parsed = NormalizedTransactionSchema.safeParse({
        externalId,
        institution,
        account,
        date,
        description,
        amountBrl: amount.abs,
        kind,
        ...(category ? { category } : {}),
      });
      if (!parsed.success) {
        errors.add(row, "schema");
        continue;
      }
      transactions.push(parsed.data);
    }

    if (header === undefined) return failed("unreadable");
  } catch (e) {
    if (e instanceof ImportLimitError) return failed("limit_exceeded");
    throw e;
  }

  const stats = {
    rowsRead,
    positions: 0,
    transactions: transactions.length,
    errorRows: errors.count(),
    ignored: {},
  };
  if (transactions.length === 0) {
    return { ...failed("no_valid_rows"), errors: errors.list(), stats };
  }
  return { positions: [], transactions, errors: errors.list(), stats };
}
