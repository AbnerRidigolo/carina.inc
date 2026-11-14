/**
 * Quebra de texto em chunks para a busca híbrida.
 *
 * - Parágrafos (separados por linha em branco) são a unidade preferida: são agrupados enquanto
 *   cabem em `maxChars` e só são cortados quando um parágrafo sozinho não cabe; o corte prefere
 *   fim de frase e, depois, espaço; só corta no meio de uma palavra gigante.
 * - Sobreposição: cada chunk depois do primeiro começa com o final (até `overlap` caracteres,
 *   alinhado a início de palavra quando possível) do chunk anterior.
 * - Nunca devolve chunk vazio; texto vazio ou só com espaços devolve `[]`.
 */

export interface ChunkOptions {
  maxChars?: number;
  overlap?: number;
}

export const DEFAULT_MAX_CHARS = 800;
export const DEFAULT_OVERLAP = 100;

const PARAGRAPH_SEP = "\n\n";

interface Unit {
  text: string;
  /** Separador que vem antes da unidade quando ela continua um chunk. */
  sep: string;
}

/** Corta um parágrafo longo em pedaços de até `size` caracteres, nas melhores fronteiras. */
function splitLong(paragraph: string, size: number): string[] {
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > size) {
    const window = rest.slice(0, size + 1);
    const half = Math.floor(size / 2);
    let cut = -1;
    // fim de frase seguido de espaço, na segunda metade da janela
    for (const m of window.matchAll(/[.!?;:]\s/g)) {
      if (m.index >= half && m.index + 1 <= size) cut = m.index + 1;
    }
    if (cut < 0) {
      const space = window.lastIndexOf(" ", size);
      const ws = Math.max(space, window.lastIndexOf("\n", size), window.lastIndexOf("\t", size));
      if (ws > 0) cut = ws;
    }
    if (cut <= 0) cut = size;
    const piece = rest.slice(0, cut).trim();
    if (piece) pieces.push(piece);
    rest = rest.slice(cut).trimStart();
  }
  const last = rest.trim();
  if (last) pieces.push(last);
  return pieces;
}

/** Final de `chunk` com até `overlap` caracteres, começando numa palavra quando possível. */
function tailOf(chunk: string, overlap: number): string {
  if (overlap === 0) return "";
  const raw = chunk.slice(-overlap);
  if (raw.length === chunk.length) return "";
  const prev = chunk.charAt(chunk.length - raw.length - 1);
  let tail = raw;
  if (!/\s/.test(prev) && !/^\s/.test(raw)) {
    const ws = raw.search(/\s/);
    if (ws >= 0) tail = raw.slice(ws);
  }
  return tail.trimStart();
}

export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new RangeError("maxChars precisa ser um inteiro positivo");
  }
  if (!Number.isInteger(overlap) || overlap < 0) {
    throw new RangeError("overlap precisa ser um inteiro não negativo");
  }
  // espaço para a sobreposição + separador + pelo menos uma parte útil
  const pieceSize = maxChars - overlap - PARAGRAPH_SEP.length;
  if (pieceSize < Math.max(1, overlap)) {
    throw new RangeError("overlap grande demais para maxChars");
  }

  const units: Unit[] = [];
  for (const para of text.split(/\n[ \t]*\n/)) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    splitLong(trimmed, pieceSize).forEach((piece, i) => {
      units.push({ text: piece, sep: i === 0 ? PARAGRAPH_SEP : " " });
    });
  }

  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    if (!current) {
      current = unit.text;
      continue;
    }
    const candidate = current + unit.sep + unit.text;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    chunks.push(current);
    const tail = tailOf(current, overlap);
    // tail ≤ overlap e unit ≤ pieceSize: sempre cabe em maxChars
    current = tail ? tail + unit.sep + unit.text : unit.text;
  }
  if (current) chunks.push(current);
  return chunks;
}
