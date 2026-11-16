const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

function hasBom(bytes: Uint8Array): boolean {
  return UTF8_BOM.every((b, i) => bytes[i] === b);
}

/**
 * Decodifica texto de arquivo importado. BOM UTF-8 vence; sem BOM tenta UTF-8
 * estrito e, se não for válido, windows-1252 (padrão das corretoras brasileiras).
 * `hint` força a codificação.
 */
export function decodeText(bytes: Uint8Array, hint?: "utf-8" | "windows-1252"): string {
  const body = hasBom(bytes) ? bytes.subarray(UTF8_BOM.length) : bytes;
  if (hint === "windows-1252" && !hasBom(bytes)) {
    return new TextDecoder("windows-1252").decode(body);
  }
  if (hint === "utf-8") {
    return new TextDecoder("utf-8").decode(body);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1252").decode(body);
  }
}
