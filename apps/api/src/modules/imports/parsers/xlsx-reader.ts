import { Inflate, strFromU8 } from "fflate";
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
  method: number;
  compressedSize: number;
  originalSize: number;
  localOffset: number;
}

const CHUNK_BYTES = 4096;
const EOCD_SIGNATURE = 0x06054b50;
const CD_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

function isAllowed(name: string): boolean {
  return (
    name === WORKBOOK_PATH ||
    name === RELS_PATH ||
    name === SHARED_STRINGS_PATH ||
    SHEET_PATH.test(name)
  );
}

/**
 * Lê o diretório central (única fonte de verdade sobre o que existe no zip) e aplica os limites
 * de contagem, soma e razão de compressão antes de inflar qualquer coisa.
 */
function readDirectory(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - EOCD_MIN - MAX_COMMENT);
  for (let i = bytes.length - EOCD_MIN; i >= lowest; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxUnreadableError();
  const total = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  let at = view.getUint32(eocd + 16, true);
  if (total === 0xffff || cdSize === 0xffffffff || at === 0xffffffff)
    throw new XlsxUnreadableError();
  if (total > PARSE_LIMITS.maxZipEntries) throw new ImportLimitError();
  if (at + cdSize > bytes.length) throw new XlsxUnreadableError();

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let sum = 0;
  for (let n = 0; n < total; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CD_SIGNATURE) {
      throw new XlsxUnreadableError();
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const originalSize = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    if (at + 46 + nameLen > bytes.length) throw new XlsxUnreadableError();
    const name = strFromU8(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;

    sum += originalSize;
    if (sum > PARSE_LIMITS.maxUnzippedBytes) throw new ImportLimitError();
    if (originalSize > 0 && originalSize > compressedSize * MAX_COMPRESSION_RATIO) {
      throw new ImportLimitError();
    }
    if (seen.has(name)) throw new XlsxUnreadableError();
    seen.add(name);
    if ((flags & 1) !== 0) throw new XlsxUnreadableError();
    entries.push({ name, method, compressedSize, originalSize, localOffset });
  }
  return entries;
}

function inflateEntry(
  bytes: Uint8Array,
  view: DataView,
  entry: ZipEntry,
  budget: { left: number },
): Uint8Array {
  const { localOffset: off } = entry;
  if (off + 30 > bytes.length || view.getUint32(off, true) !== LOCAL_SIGNATURE) {
    throw new XlsxUnreadableError();
  }
  const nameLen = view.getUint16(off + 26, true);
  const extraLen = view.getUint16(off + 28, true);
  const nameEnd = off + 30 + nameLen;
  if (nameEnd > bytes.length || strFromU8(bytes.subarray(off + 30, nameEnd)) !== entry.name) {
    throw new XlsxUnreadableError();
  }
  const start = nameEnd + extraLen;
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new XlsxUnreadableError();
  const data = bytes.subarray(start, end);

  budget.left -= entry.originalSize;
  if (budget.left < 0) throw new ImportLimitError();

  if (entry.method === 0) {
    if (data.length !== entry.originalSize) throw new XlsxUnreadableError();
    return data.slice();
  }
  if (entry.method !== 8) throw new XlsxUnreadableError();

  const parts: Uint8Array[] = [];
  let written = 0;
  let done = false;
  const inflater = new Inflate((chunk, final) => {
    written += chunk.length;
    if (written > entry.originalSize) throw new ImportLimitError();
    parts.push(chunk);
    if (final) done = true;
  });
  try {
    for (let i = 0; i < data.length; i += CHUNK_BYTES) {
      const stop = Math.min(i + CHUNK_BYTES, data.length);
      inflater.push(data.subarray(i, stop), stop === data.length);
    }
  } catch (err) {
    if (err instanceof ImportLimitError) throw err;
    throw new XlsxUnreadableError();
  }
  if (!done) throw new XlsxUnreadableError();
  const out = new Uint8Array(written);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Infla só as entradas permitidas, endereçadas pelo diretório central, com orçamento global de bytes. */
function unzipLimited(bytes: Uint8Array): Record<string, Uint8Array> {
  const entries = readDirectory(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const budget = { left: PARSE_LIMITS.maxUnzippedBytes };
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    if (isAllowed(entry.name)) files[entry.name] = inflateEntry(bytes, view, entry, budget);
  }
  return files;
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
