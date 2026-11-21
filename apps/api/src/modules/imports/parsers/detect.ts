import { unzipSync } from "fflate";
import type { ImportFormat } from "@carina/shared";
import { records } from "./csv.js";
import { ImportLimitError } from "./types.js";
import { decodeText } from "./decode.js";

const SNIFF_BYTES = 1024;
const CSV_SNIFF_BYTES = 65_536;
const CSV_LINES = 5;
/** Os mesmos que o parser de CSV aceita. */
const DELIMITERS = [";", ","] as const;

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

/**
 * Colunas dos primeiros registros com o tokenizer do parser (aspas e quebra de linha dentro de
 * aspas). Se a amostra cortou o arquivo, o último registro pode estar incompleto e é descartado.
 */
function columnCounts(text: string, delimiter: string, truncated: boolean): number[] | null {
  const counts: number[] = [];
  try {
    for (const rec of records(text, delimiter)) {
      if (rec.fields.length === 1 && rec.fields[0]?.trim() === "") continue;
      counts.push(rec.fields.length);
      if (counts.length > CSV_LINES) break;
    }
  } catch (e) {
    if (e instanceof ImportLimitError) return null;
    throw e;
  }
  if (truncated && counts.length <= CSV_LINES) counts.pop();
  return counts.slice(0, CSV_LINES);
}

function isCsv(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, CSV_SNIFF_BYTES);
  if (sample.includes(0)) return false;
  const text = decodeText(sample);
  const truncated = bytes.length > CSV_SNIFF_BYTES;
  return DELIMITERS.some((d) => {
    const counts = columnCounts(text, d, truncated) ?? [];
    const first = counts[0];
    return first !== undefined && first >= 2 && counts.every((c) => c === first);
  });
}

/** Detecta o formato pelo conteúdo (nunca pelo nome ou content-type). `null` se desconhecido. */
export function detectFormat(bytes: Uint8Array): ImportFormat | null {
  if (bytes.length === 0) return null;
  if (isZip(bytes)) return isXlsx(bytes) ? "b3_xlsx" : null;
  if (isOfx(bytes)) return "ofx";
  return isCsv(bytes) ? "csv" : null;
}
