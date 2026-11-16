import { unzipSync } from "fflate";
import type { ImportFormat } from "@carina/shared";
import { decodeText } from "./decode.js";

const SNIFF_BYTES = 1024;
const CSV_SNIFF_BYTES = 65_536;
const CSV_LINES = 5;
const DELIMITERS = [";", ",", "\t"] as const;

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function isXlsx(bytes: Uint8Array): boolean {
  const names = new Set<string>();
  try {
    // O filtro devolve false: só lê o diretório central, sem descompactar nada.
    unzipSync(bytes, {
      filter: (file) => {
        names.add(file.name);
        return false;
      },
    });
  } catch {
    return false;
  }
  return names.has("[Content_Types].xml") && names.has("xl/workbook.xml");
}

function isOfx(bytes: Uint8Array): boolean {
  const head = decodeText(bytes.subarray(0, SNIFF_BYTES)).replace(/^\s+/, "");
  return head.startsWith("OFXHEADER:") || head.includes("<?OFX") || head.includes("<OFX>");
}

function countColumns(line: string, delimiter: string): number {
  let columns = 1;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === delimiter && !quoted) columns += 1;
  }
  return columns;
}

function isCsv(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, CSV_SNIFF_BYTES);
  if (sample.includes(0)) return false;
  const lines = decodeText(sample)
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim() !== "")
    .slice(0, CSV_LINES);
  const [head] = lines;
  if (head === undefined) return false;
  return DELIMITERS.some((d) => {
    const first = countColumns(head, d);
    return first >= 2 && lines.every((l) => countColumns(l, d) === first);
  });
}

/** Detecta o formato pelo conteúdo (nunca pelo nome ou content-type). `null` se desconhecido. */
export function detectFormat(bytes: Uint8Array): ImportFormat | null {
  if (bytes.length === 0) return null;
  if (isZip(bytes)) return isXlsx(bytes) ? "b3_xlsx" : null;
  if (isOfx(bytes)) return "ofx";
  return isCsv(bytes) ? "csv" : null;
}
