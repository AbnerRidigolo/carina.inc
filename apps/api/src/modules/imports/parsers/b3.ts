/**
 * Parser da planilha da Área do Investidor B3 (layout reconstruído).
 *
 * Abas são casadas pelo nome sem acento, em minúsculas, começando com o prefixo; o cabeçalho é a
 * primeira linha não vazia. Mapeamento de `assetClass` pela aba de Posição (o prefixo opcional
 * `posicao -` é aceito):
 *   Acoes, BDR, ETF                 -> acao
 *   Fundo de Investimento           -> fii se o código termina em `11` ou o nome é de FII; senão fundo
 *   Fundos Imobiliarios / FII       -> fii (mesma regra, com fii como padrão)
 *   Tesouro Direto                  -> tesouro
 *   Renda Fixa                      -> renda_fixa
 * Aba fora dessa lista conta em `stats.ignored["aba:<nome normalizado>"]`; aba reconhecida sem as
 * colunas obrigatórias também (e, sem nenhuma aba utilizável, o arquivo falha como `unreadable`).
 */
import { createHash } from "node:crypto";
import {
  type NormalizedPosition,
  NormalizedPositionSchema,
  type NormalizedTransaction,
  NormalizedTransactionSchema,
} from "@carina/shared";
import { parseAmount } from "./amount.js";
import { deriveExternalId, OccurrenceCounter } from "./external-id.js";
import { type RowErrorCode, RowErrors } from "./row-errors.js";
import { ImportLimitError, PARSE_LIMITS, type ParseResult } from "./types.js";
import { type CellValue, readWorkbook, XlsxUnreadableError } from "./xlsx-reader.js";

export type B3Result = ParseResult & { positionInstitutions: string[] };

const SEP = "\u001f";
const ACCOUNT = "B3";
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;
const MAX_IGNORED_KEY = 64;

type AssetClass = NormalizedPosition["assetClass"];
type SheetKind =
  | { type: "position"; assetClass: AssetClass; mixedFunds: boolean }
  | { type: "movimentacao" }
  | { type: "negociacao" };

/** Sem acento, minúsculo, espaços colapsados. */
const fold = (s: string): string =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

function classify(name: string): SheetKind | undefined {
  const n = fold(name);
  if (n.startsWith("movimentacao")) return { type: "movimentacao" };
  if (n.startsWith("negociacao")) return { type: "negociacao" };
  const rest = n.replace(/^posicao\s*[-:–]?\s*/, "");
  if (rest.startsWith("acoes") || rest.startsWith("bdr") || rest.startsWith("etf")) {
    return { type: "position", assetClass: "acao", mixedFunds: false };
  }
  if (rest.startsWith("fundo imobiliario") || rest.startsWith("fundos imobiliarios")) {
    return { type: "position", assetClass: "fii", mixedFunds: true };
  }
  if (rest.startsWith("fii")) return { type: "position", assetClass: "fii", mixedFunds: true };
  if (rest.startsWith("fundo")) return { type: "position", assetClass: "fundo", mixedFunds: true };
  if (rest.startsWith("tesouro")) {
    return { type: "position", assetClass: "tesouro", mixedFunds: false };
  }
  if (rest.startsWith("renda fixa")) {
    return { type: "position", assetClass: "renda_fixa", mixedFunds: false };
  }
  return undefined;
}

function isFii(code: string, name: string): boolean {
  return /11$/.test(code.trim()) || /\bfii\b|imobili/i.test(fold(name));
}

function failed(failure: NonNullable<ParseResult["failure"]>): B3Result {
  return {
    positions: [],
    transactions: [],
    errors: [],
    stats: { rowsRead: 0, positions: 0, transactions: 0, errorRows: 0, ignored: {} },
    failure,
    positionInstitutions: [],
  };
}

const isFormula = (c: CellValue | undefined): boolean => typeof c === "object" && c !== null;

/** Texto normalizado da célula; número vira sua forma decimal curta. */
function textOf(c: CellValue | undefined): string {
  if (typeof c === "string") return c.normalize("NFC").trim();
  if (typeof c === "number") return String(c);
  return "";
}

const isBlank = (s: string): boolean => s === "" || s === "-";

function parseDate(c: CellValue | undefined): string | undefined {
  let y: number;
  let mo: number;
  let d: number;
  if (typeof c === "number") {
    // Serial do Excel (base 1899-12-30); antes de 61 vale o bug do ano bissexto de 1900.
    if (!Number.isFinite(c) || c < 61 || c > 2_958_465) return undefined;
    const dt = new Date(EXCEL_EPOCH_MS + Math.floor(c) * DAY_MS);
    [y, mo, d] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
  } else {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(textOf(c));
    if (!m) return undefined;
    [y, mo, d] = [Number(m[3]), Number(m[2]), Number(m[1])];
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (
      probe.getUTCFullYear() !== y ||
      probe.getUTCMonth() !== mo - 1 ||
      probe.getUTCDate() !== d
    ) {
      return undefined;
    }
  }
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

type Parsed = { value: string } | { error: RowErrorCode };

/** Valor em BRL com a regra `comma` do CSV; célula numérica passa pela mesma regra. */
function parseMoney(c: CellValue | undefined): Parsed {
  const raw = typeof c === "number" ? String(c).replace(".", ",") : textOf(c);
  if (isBlank(raw)) return { error: "missing_field" };
  const a = parseAmount(raw, "comma");
  if ("error" in a) return { error: a.error };
  return { value: `${a.sign < 0 ? "-" : ""}${a.abs}` };
}

/** Quantidade pt-BR (até 8 casas). Vazia ou `-` é ausente (`value: ""`). */
function parseQuantity(c: CellValue | undefined): Parsed {
  const raw = (typeof c === "number" ? String(c).replace(".", ",") : textOf(c)).replace(/\s/g, "");
  if (isBlank(raw)) return { value: "" };
  const m = /^(-)?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,8}))?$/.exec(raw);
  if (!m) return { error: "invalid_quantity" };
  const int = (m[2] ?? "").replaceAll(".", "").replace(/^0+(?=\d)/, "");
  if (int.length > 16) return { error: "invalid_quantity" };
  return { value: `${m[1] ?? ""}${int}${m[3] === undefined ? "" : `.${m[3]}`}` };
}

const lower = (s: string): string => s.normalize("NFC").trim().toLowerCase();

interface Ctx {
  errors: RowErrors;
  counter: OccurrenceCounter;
  positions: NormalizedPosition[];
  transactions: NormalizedTransaction[];
  ignored: Record<string, number>;
  institutions: string[];
  positionKeys: Map<string, number>;
  asOf: string;
  rowsRead: number;
  deadline: number;
}

type Row = Array<CellValue>;
type Cols = Map<string, number>;

/** Cabeçalho = primeira linha não vazia; retorna o índice e as colunas normalizadas. */
function findHeader(rows: Row[]): { at: number; cols: Cols } | undefined {
  const at = rows.findIndex((r) => r.some((c) => c !== null));
  if (at < 0) return undefined;
  const cols: Cols = new Map();
  (rows[at] ?? []).forEach((c, i) => {
    const key = fold(textOf(c));
    if (key && !cols.has(key)) cols.set(key, i);
  });
  return { at, cols };
}

interface Spec {
  /** Nome canônico (usado em `field`) -> chave normalizada do cabeçalho. */
  required: Record<string, string>;
  optional: Record<string, string>;
}

function resolve(cols: Cols, spec: Spec): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const [name, key] of Object.entries(spec.required)) {
    const i = cols.get(key);
    if (i === undefined) return undefined;
    out[name] = i;
  }
  for (const [name, key] of Object.entries(spec.optional)) {
    const i = cols.get(key);
    if (i !== undefined) out[name] = i;
  }
  return out;
}

const POSITION_SPEC: Spec = {
  required: {
    Produto: "produto",
    Instituição: "instituicao",
    Quantidade: "quantidade",
    "Valor Atualizado": "valor atualizado",
  },
  optional: { "Código de Negociação": "codigo de negociacao" },
};
const MOV_SPEC: Spec = {
  required: {
    Data: "data",
    Movimentação: "movimentacao",
    Produto: "produto",
    Instituição: "instituicao",
    "Valor da Operação": "valor da operacao",
  },
  optional: {
    "Entrada/Saída": "entrada/saida",
    Quantidade: "quantidade",
    "Preço unitário": "preco unitario",
  },
};
const NEG_SPEC: Spec = {
  required: {
    "Data do Negócio": "data do negocio",
    "Tipo de Movimentação": "tipo de movimentacao",
    Instituição: "instituicao",
    "Código de Negociação": "codigo de negociacao",
    Quantidade: "quantidade",
    Valor: "valor",
  },
  optional: { Preço: "preco" },
};

const MOV_KINDS: Record<string, "dividend" | "jcp"> = {
  dividendo: "dividend",
  "juros sobre capital proprio": "jcp",
  rendimento: "dividend",
};
const NEG_KINDS: Record<string, "buy" | "sell"> = { compra: "buy", venda: "sell" };

/** Primeira célula de fórmula sem valor entre as colunas usadas pela linha, se houver. */
function formulaField(row: Row, idx: Record<string, number>): string | undefined {
  return Object.entries(idx).find(([, i]) => isFormula(row[i]))?.[0];
}

function readPositions(
  rows: Row[],
  from: number,
  idx: Record<string, number>,
  kind: SheetKind,
  ctx: Ctx,
) {
  if (kind.type !== "position") return;
  const code = idx["Código de Negociação"];
  for (let r = from; r < rows.length; r++) {
    const row = rows[r] ?? [];
    if (!row.some((c) => c !== null)) continue;
    ctx.rowsRead += 1;
    if (ctx.rowsRead > PARSE_LIMITS.maxRows) throw new ImportLimitError();
    if (ctx.rowsRead % 1024 === 0 && Date.now() > ctx.deadline) throw new ImportLimitError();
    const n = r + 1;
    const cell = (name: string): CellValue | undefined => row[idx[name] ?? -1];

    const bad = formulaField(row, idx);
    if (bad !== undefined) {
      ctx.errors.add(n, "formula_without_value", bad);
      continue;
    }
    const name = textOf(cell("Produto"));
    const institution = textOf(cell("Instituição"));
    const assetCode = code === undefined ? "" : textOf(row[code]);
    if (!name) {
      ctx.errors.add(n, "missing_field", "Produto");
      continue;
    }
    if (!institution) {
      ctx.errors.add(n, "missing_field", "Instituição");
      continue;
    }
    const value = parseMoney(cell("Valor Atualizado"));
    if ("error" in value) {
      ctx.errors.add(n, value.error, "Valor Atualizado");
      continue;
    }
    const qty = parseQuantity(cell("Quantidade"));
    if ("error" in qty) {
      ctx.errors.add(n, qty.error, "Quantidade");
      continue;
    }
    let assetClass = kind.assetClass;
    if (kind.mixedFunds && isFii(assetCode, name)) assetClass = "fii";

    // Chave estável entre fotografias; repetida no mesmo arquivo, ganha o número da ocorrência.
    const key = `${institution.toLowerCase()}|${lower(assetCode || name)}`;
    const seen = ctx.positionKeys.get(key) ?? 0;
    ctx.positionKeys.set(key, seen + 1);
    const hash = createHash("sha256")
      .update(seen === 0 ? key : `${key}${SEP}${seen}`)
      .digest("hex");

    const parsed = NormalizedPositionSchema.safeParse({
      externalId: `b3:pos:${hash}`,
      institution,
      kind: "investment",
      assetClass,
      ...(assetCode ? { assetCode } : {}),
      name,
      ...(qty.value ? { quantity: qty.value } : {}),
      valueBrl: value.value,
      asOf: ctx.asOf,
    });
    if (!parsed.success) {
      ctx.errors.add(n, "schema");
      continue;
    }
    ctx.positions.push(parsed.data);
    if (!ctx.institutions.includes(institution)) ctx.institutions.push(institution);
  }
}

function readTransactions(
  rows: Row[],
  from: number,
  idx: Record<string, number>,
  kind: SheetKind,
  ctx: Ctx,
) {
  const isMov = kind.type === "movimentacao";
  const prefix = isMov ? "b3:movimentacao" : "b3:negociacao";
  for (let r = from; r < rows.length; r++) {
    const row = rows[r] ?? [];
    if (!row.some((c) => c !== null)) continue;
    ctx.rowsRead += 1;
    if (ctx.rowsRead > PARSE_LIMITS.maxRows) throw new ImportLimitError();
    if (ctx.rowsRead % 1024 === 0 && Date.now() > ctx.deadline) throw new ImportLimitError();
    const n = r + 1;
    const cell = (name: string): CellValue | undefined => row[idx[name] ?? -1];
    const text = (name: string): string => textOf(cell(name));

    const bad = formulaField(row, idx);
    if (bad !== undefined) {
      ctx.errors.add(n, "formula_without_value", bad);
      continue;
    }

    const typeField = isMov ? "Movimentação" : "Tipo de Movimentação";
    const dateField = isMov ? "Data" : "Data do Negócio";
    const amountField = isMov ? "Valor da Operação" : "Valor";
    const typeKey = fold(text(typeField));
    if (!typeKey) {
      ctx.errors.add(n, "missing_field", typeField);
      continue;
    }
    let txKind: NormalizedTransaction["kind"];
    if (isMov) {
      const k = MOV_KINDS[typeKey];
      if (k === undefined) {
        const key = typeKey.slice(0, MAX_IGNORED_KEY);
        ctx.ignored[key] = (ctx.ignored[key] ?? 0) + 1;
        continue;
      }
      txKind = k;
    } else {
      const k = NEG_KINDS[typeKey];
      if (k === undefined) {
        ctx.errors.add(n, "unknown_kind", typeField);
        continue;
      }
      txKind = k;
    }

    const institution = text("Instituição");
    if (!institution) {
      ctx.errors.add(n, "missing_field", "Instituição");
      continue;
    }
    const product = isMov ? text("Produto") : text("Código de Negociação");
    if (!product) {
      ctx.errors.add(n, "missing_field", isMov ? "Produto" : "Código de Negociação");
      continue;
    }
    if (isBlank(textOf(cell(dateField)))) {
      ctx.errors.add(n, "missing_field", dateField);
      continue;
    }
    const date = parseDate(cell(dateField));
    if (date === undefined) {
      ctx.errors.add(n, "invalid_date", dateField);
      continue;
    }
    const amount = parseMoney(cell(amountField));
    if ("error" in amount) {
      ctx.errors.add(n, amount.error, amountField);
      continue;
    }
    const qty = parseQuantity(cell("Quantidade"));
    if ("error" in qty || (!isMov && qty.value === "")) {
      ctx.errors.add(n, "error" in qty ? qty.error : "missing_field", "Quantidade");
      continue;
    }
    const priceField = isMov ? "Preço unitário" : "Preço";

    // Mesmas partes para o id e para a chave de ocorrência.
    const parts = isMov
      ? [
          lower(text("Entrada/Saída")),
          date,
          typeKey,
          lower(product),
          lower(institution),
          qty.value,
          lower(text(priceField)),
          amount.value,
        ]
      : [
          date,
          typeKey,
          lower(institution),
          lower(product),
          qty.value,
          lower(text(priceField)),
          amount.value,
        ];
    const externalId = deriveExternalId(
      prefix,
      parts,
      ctx.counter.next(`${prefix}${SEP}${parts.join(SEP)}`),
    );

    const parsed = NormalizedTransactionSchema.safeParse({
      externalId,
      institution,
      account: ACCOUNT,
      date,
      description: isMov ? product : `${typeKey === "compra" ? "Compra" : "Venda"} ${product}`,
      amountBrl: amount.value,
      kind: txKind,
      ...(isMov ? {} : { assetCode: product }),
      ...(qty.value ? { quantity: qty.value } : {}),
    });
    if (!parsed.success) {
      ctx.errors.add(n, "schema");
      continue;
    }
    ctx.transactions.push(parsed.data);
  }
}

export function parseB3(bytes: Uint8Array, opts: { asOf?: string }): B3Result {
  let workbook;
  try {
    workbook = readWorkbook(bytes);
  } catch (e) {
    if (e instanceof ImportLimitError) return failed("limit_exceeded");
    if (e instanceof XlsxUnreadableError) return failed("unreadable");
    throw e;
  }

  const ctx: Ctx = {
    errors: new RowErrors(),
    counter: new OccurrenceCounter(),
    positions: [],
    transactions: [],
    ignored: {},
    institutions: [],
    positionKeys: new Map(),
    asOf: opts.asOf ?? "",
    rowsRead: 0,
    deadline: Date.now() + PARSE_LIMITS.parseTimeoutMs,
  };

  try {
    let recognized = 0;
    let hasPositionSheet = false;
    let positionRows = 0;
    for (const sheet of workbook.sheets) {
      const kind = classify(sheet.name);
      const header = kind === undefined ? undefined : findHeader(sheet.rows);
      const spec =
        kind?.type === "position"
          ? POSITION_SPEC
          : kind?.type === "movimentacao"
            ? MOV_SPEC
            : NEG_SPEC;
      const idx = header === undefined ? undefined : resolve(header.cols, spec);
      if (kind === undefined || header === undefined || idx === undefined) {
        const key = `aba:${fold(sheet.name)}`.slice(0, MAX_IGNORED_KEY);
        ctx.ignored[key] = (ctx.ignored[key] ?? 0) + 1;
        continue;
      }
      recognized += 1;
      if (kind.type === "position") {
        hasPositionSheet = true;
        if (opts.asOf === undefined) return failed("missing_as_of");
        positionRows += sheet.rows
          .slice(header.at + 1)
          .filter((r) => r.some((c) => c !== null)).length;
        if (positionRows > PARSE_LIMITS.maxPositions) return failed("limit_exceeded");
        readPositions(sheet.rows, header.at + 1, idx, kind, ctx);
      } else {
        readTransactions(sheet.rows, header.at + 1, idx, kind, ctx);
      }
    }
    if (recognized === 0 && !hasPositionSheet) return failed("unreadable");
  } catch (e) {
    if (e instanceof ImportLimitError) return failed("limit_exceeded");
    throw e;
  }

  const stats = {
    rowsRead: ctx.rowsRead,
    positions: ctx.positions.length,
    transactions: ctx.transactions.length,
    errorRows: ctx.errors.count(),
    ignored: ctx.ignored,
  };
  if (ctx.positions.length === 0 && ctx.transactions.length === 0) {
    return { ...failed("no_valid_rows"), errors: ctx.errors.list(), stats };
  }
  return {
    positions: ctx.positions,
    transactions: ctx.transactions,
    errors: ctx.errors.list(),
    stats,
    positionInstitutions: ctx.institutions,
  };
}
