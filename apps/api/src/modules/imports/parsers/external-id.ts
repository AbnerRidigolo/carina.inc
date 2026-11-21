import { createHash } from "node:crypto";

const SEPARATOR = "\u001f";
const MAX_LENGTH = 128;

/**
 * Chave derivada e estável para linhas sem identificador próprio:
 * `prefix:` + sha256 hex das partes e da ocorrência (cortado para caber em 128).
 */
export function deriveExternalId(
  prefix: string,
  parts: readonly string[],
  occurrence: number,
): string {
  const hash = createHash("sha256")
    .update(`${parts.join(SEPARATOR)}${SEPARATOR}${occurrence}`)
    .digest("hex");
  return `${prefix}:${hash}`.slice(0, MAX_LENGTH);
}

/** Numera linhas repetidas (0, 1, 2…) por chave, para que duplicatas legítimas não colidam. */
export class OccurrenceCounter {
  private readonly counts = new Map<string, number>();

  next(key: string): number {
    const n = this.counts.get(key) ?? 0;
    this.counts.set(key, n + 1);
    return n;
  }
}
