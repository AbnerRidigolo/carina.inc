/**
 * Embeddings determinísticos e offline para o modo mock (`LLM_MODE=mock`): "bag of words" com hash.
 *
 * Tokens = sequências de `\p{L}\p{N}` em minúsculas, sem acentos (NFD + remoção das marcas). Cada
 * token soma 1 na posição `fnv1a32(token) % dimensions`; o vetor final é normalizado em L2. Texto
 * sem tokens dá o vetor zero com `[0] = 1` (norma 1, nunca NaN).
 */
import type { EmbeddingsInterface } from "@langchain/core/embeddings";

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const encoder = new TextEncoder();

/** FNV-1a de 32 bits sobre os bytes UTF-8 da string (sem sinal). */
export function fnv1a32(s: string): number {
  let h = FNV_OFFSET;
  for (const byte of encoder.encode(s)) {
    h ^= byte;
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

export function tokenize(text: string): string[] {
  const folded = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return folded.match(/[\p{L}\p{N}]+/gu) ?? [];
}

export class HashEmbeddings implements EmbeddingsInterface {
  constructor(readonly dimensions = 1024) {}

  embed(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    const tokens = tokenize(text);
    if (tokens.length === 0) {
      v[0] = 1;
      return v;
    }
    for (const t of tokens) {
      const i = fnv1a32(t) % this.dimensions;
      v[i] = (v[i] ?? 0) + 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map((x) => x / norm);
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embed(t));
  }
}
