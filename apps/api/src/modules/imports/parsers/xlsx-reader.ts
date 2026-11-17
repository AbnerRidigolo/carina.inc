import { strFromU8, Unzip, UnzipInflate, UnzipPassThrough, unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { ImportLimitError, PARSE_LIMITS } from "./types.js";

export type CellValue = string | number | null | { formulaWithoutValue: true };

export interface Workbook {
  sheets: Array<{ name: string; rows: Array<Array<CellValue>> }>;
}

/** Lançada quando o arquivo não é um XLSX legível ou traz XML proibido (DTD/entidades). */
export class XlsxUnreadableError extends Error {
  readonly code = "xlsx_unreadable" as const;

  constructor(message = "Arquivo XLSX ilegível.") {
    super(message);
    this.name = "XlsxUnreadableError";
  }
}

const MAX_COMPRESSION_RATIO = 200;
const WORKBOOK_PATH = "xl/workbook.xml";
const RELS_PATH = "xl/_rels/workbook.xml.rels";
const SHARED_STRINGS_PATH = "xl/sharedStrings.xml";
const SHEET_PATH = /^xl\/worksheets\/[^/]+\.xml$/;
const FORBIDDEN_XML = /<!DOCTYPE|<!ENTITY/i;

const ARRAY_TAGS = new Set(["sheet", "Relationship", "si", "r", "t", "row", "c"]);

const parser = new XMLParser({
  processEntities: false,
  allowBooleanAttributes: false,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  removeNSPrefix: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

type Node = Record<string, unknown>;

const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

interface ZipEntry {
  name: string;
  originalSize: number;
}

const CHUNK_BYTES = 16_384;

function isAllowed(name: string): boolean {
  return (
    name === WORKBOOK_PATH ||
    name === RELS_PATH ||
    name === SHARED_STRINGS_PATH ||
    SHEET_PATH.test(name)
  );
}

/** 1ª passada: só o diretório central (filtro devolve false), aplicando os limites antes de inflar qualquer coisa. */
function scanDirectory(bytes: Uint8Array): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let total = 0;
  try {
    unzipSync(bytes, {
      filter: (file) => {
        if (entries.length + 1 > PARSE_LIMITS.maxZipEntries) throw new ImportLimitError();
        total += file.originalSize;
        if (total > PARSE_LIMITS.maxUnzippedBytes) throw new ImportLimitError();
        if (file.originalSize > 0 && file.originalSize > file.size * MAX_COMPRESSION_RATIO) {
          throw new ImportLimitError();
        }
        entries.push({ name: file.name, originalSize: file.originalSize });
        return false;
      },
    });
  } catch (err) {
    if (err instanceof ImportLimitError) throw err;
    throw new XlsxUnreadableError();
  }
  return entries;
}

/**
 * 2ª passada: infla só as entradas permitidas, em fluxo, e aborta assim que a saída passa do
 * tamanho declarado no diretório central (um `originalSize` mentiroso não vira CPU ilimitada).
 */
function inflateAllowed(bytes: Uint8Array, entries: ZipEntry[]): Record<string, Uint8Array> {
  const declared = new Map<string, number>();
  for (const e of entries) {
    if (!isAllowed(e.name)) continue;
    if (declared.has(e.name)) throw new XlsxUnreadableError();
    declared.set(e.name, e.originalSize);
  }
  const files: Record<string, Uint8Array> = {};
  const unzip = new Unzip((file) => {
    const limit = declared.get(file.name);
    if (limit === undefined) return;
    const parts: Uint8Array[] = [];
    let written = 0;
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      written += chunk.length;
      if (written > limit) {
        file.terminate();
        throw new ImportLimitError();
      }
      parts.push(chunk);
      if (final) {
        const out = new Uint8Array(written);
        let at = 0;
        for (const part of parts) {
          out.set(part, at);
          at += part.length;
        }
        files[file.name] = out;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  try {
    for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
      const end = Math.min(at + CHUNK_BYTES, bytes.length);
      unzip.push(bytes.subarray(at, end), end === bytes.length);
    }
  } catch (err) {
    if (err instanceof ImportLimitError) throw err;
    throw new XlsxUnreadableError();
  }
  return files;
}

function unzipLimited(bytes: Uint8Array): Record<string, Uint8Array> {
  return inflateAllowed(bytes, scanDirectory(bytes));
}

const XML_REFS: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodifica só as referências predefinidas e numéricas; nunca entidades declaradas em DTD. */
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, ref: string) => {
    if (ref.startsWith("#")) {
      const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : m;
    }
    return XML_REFS[ref] ?? m;
  });
}

function parseXml(files: Record<string, Uint8Array>, path: string): Node {
  const raw = files[path];
  if (raw === undefined) throw new XlsxUnreadableError();
  const text = strFromU8(raw);
  if (FORBIDDEN_XML.test(text)) throw new XlsxUnreadableError();
  try {
    const doc: unknown = parser.parse(text);
    return isNode(doc) ? doc : {};
  } catch {
    throw new XlsxUnreadableError();
  }
}

function textOf(v: unknown): string {
  if (typeof v === "string") return decodeXml(v);
  if (isNode(v) && typeof v["#text"] === "string") return decodeXml(v["#text"]);
  return "";
}

function sharedStrings(files: Record<string, Uint8Array>): string[] {
  if (files[SHARED_STRINGS_PATH] === undefined) return [];
  const sst = parseXml(files, SHARED_STRINGS_PATH)["sst"];
  if (!isNode(sst)) return [];
  return asArray(sst["si"]).map((si) => {
    if (!isNode(si)) return "";
    // Texto simples (<t>) ou rich text (<r><t>…</t></r>); fonética (<rPh>) é ignorada.
    const parts = asArray(si["t"]).map(textOf);
    for (const run of asArray(si["r"])) {
      if (isNode(run)) parts.push(...asArray(run["t"]).map(textOf));
    }
    return parts.join("");
  });
}

function sheetTargets(files: Record<string, Uint8Array>): Array<{ name: string; path: string }> {
  const workbook = parseXml(files, WORKBOOK_PATH)["workbook"];
  const rels = parseXml(files, RELS_PATH)["Relationships"];
  if (!isNode(workbook) || !isNode(rels)) throw new XlsxUnreadableError();
  const sheetsNode = workbook["sheets"];
  const targets = new Map<string, string>();
  for (const rel of asArray(rels["Relationship"])) {
    if (!isNode(rel)) continue;
    const id = rel["@_Id"];
    const rawTarget = rel["@_Target"];
    if (typeof id !== "string" || typeof rawTarget !== "string") continue;
    const target = decodeXml(rawTarget);
    targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const out: Array<{ name: string; path: string }> = [];
  for (const sheet of asArray(isNode(sheetsNode) ? sheetsNode["sheet"] : undefined)) {
    if (!isNode(sheet)) continue;
    const name = sheet["@_name"];
    const rid = sheet["@_id"];
    const path = typeof rid === "string" ? targets.get(rid) : undefined;
    if (typeof name !== "string" || path === undefined || !SHEET_PATH.test(path)) {
      throw new XlsxUnreadableError();
    }
    if (out.length >= PARSE_LIMITS.maxZipEntries) throw new ImportLimitError();
    if (out.some((o) => o.path === path)) throw new XlsxUnreadableError();
    out.push({ name: decodeXml(name), path });
  }
  if (out.length === 0) throw new XlsxUnreadableError();
  return out;
}

function columnIndex(ref: string): number {
  const letters = /^[A-Za-z]+/.exec(ref)?.[0];
  if (letters === undefined) throw new XlsxUnreadableError();
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function cellValue(cell: unknown, strings: string[]): CellValue {
  if (!isNode(cell)) return null;
  const type = cell["@_t"];
  const rawV = cell["v"];
  const v = typeof rawV === "string" ? rawV : undefined;
  if (type === "inlineStr")
    return (
      asArray(cell["is"])
        .map((is) => (isNode(is) ? asArray(is["t"]).map(textOf).join("") : ""))
        .join("") || null
    );
  if (v === undefined || v === "") {
    return cell["f"] !== undefined ? { formulaWithoutValue: true } : null;
  }
  switch (type) {
    case "s":
      return strings[Number(v)] ?? null;
    case "b":
      return v === "1" ? "TRUE" : "FALSE";
    case "e":
      return null;
    case "str":
    case "d":
      return v;
    default: {
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }
  }
}

function readSheet(files: Record<string, Uint8Array>, path: string, strings: string[]) {
  const sheet = parseXml(files, path)["worksheet"];
  const data = isNode(sheet) ? sheet["sheetData"] : undefined;
  const rows: Array<Array<CellValue>> = [];
  for (const row of asArray(isNode(data) ? data["row"] : undefined)) {
    if (!isNode(row)) continue;
    const refRow = Number(row["@_r"]);
    const index = Number.isInteger(refRow) && refRow > 0 ? refRow - 1 : rows.length;
    if (index >= PARSE_LIMITS.maxRows) throw new ImportLimitError();
    while (rows.length < index) rows.push([]);
    const cells: Array<CellValue> = [];
    let next = 0;
    for (const cell of asArray(row["c"])) {
      const ref = isNode(cell) ? cell["@_r"] : undefined;
      const col = typeof ref === "string" ? columnIndex(ref) : next;
      if (col >= PARSE_LIMITS.maxColumns) throw new ImportLimitError();
      while (cells.length < col) cells.push(null);
      cells[col] = cellValue(cell, strings);
      next = col + 1;
    }
    rows[index] = cells;
  }
  return rows;
}

/** Lê um XLSX com limites de descompactação e sem resolver entidades. Datas seguem como número serial. */
export function readWorkbook(bytes: Uint8Array): Workbook {
  const files = unzipLimited(bytes);
  const strings = sharedStrings(files);
  const sheets = sheetTargets(files).map(({ name, path }) => ({
    name,
    rows: readSheet(files, path, strings),
  }));
  return { sheets };
}
