import { describe, expect, it } from "vitest";
import { chunkText } from "./chunker.js";

/** Parágrafo de ~`size` caracteres com palavras distintas (para conferir a sobreposição). */
function paragraph(seed: number, size: number): string {
  const words: string[] = [];
  let len = 0;
  for (let i = 0; len < size; i++) {
    const w = `p${seed}w${i}`;
    words.push(w);
    len += w.length + 1;
  }
  return words.join(" ").slice(0, size).trimEnd();
}

/** Algum sufixo de `a` (não vazio) é prefixo de `b`. */
function overlaps(a: string, b: string): boolean {
  for (let n = Math.min(a.length, b.length); n > 0; n--) {
    if (b.startsWith(a.slice(-n))) return true;
  }
  return false;
}

describe("chunkText", () => {
  it("texto de 2.000 caracteres em parágrafos gera de 3 a 4 chunks, nenhum acima de 800", () => {
    const paras = Array.from({ length: 10 }, (_, i) => paragraph(i, 198));
    const text = paras.join("\n\n");
    expect(text.length).toBeGreaterThanOrEqual(1990);
    expect(text.length).toBeLessThanOrEqual(2010);

    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.length).toBeLessThanOrEqual(4);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(800);
      expect(c.trim()).not.toBe("");
    }
  });

  it("parágrafo único de 2.000 caracteres também gera de 3 a 4 chunks", () => {
    const text = paragraph(0, 2000);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.length).toBeLessThanOrEqual(4);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(800);
  });

  it("cada chunk termina com um trecho que começa o próximo (sobreposição de até 100)", () => {
    const text = Array.from({ length: 10 }, (_, i) => paragraph(i, 198)).join("\n\n");
    const chunks = chunkText(text);
    for (let i = 0; i + 1 < chunks.length; i++) {
      const a = chunks[i] ?? "";
      const b = chunks[i + 1] ?? "";
      expect(overlaps(a, b)).toBe(true);
      // o trecho comum tem no máximo ~100 caracteres e não é o chunk anterior inteiro
      let n = Math.min(a.length, b.length);
      while (n > 0 && !b.startsWith(a.slice(-n))) n--;
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThanOrEqual(100);
      expect(n).toBeLessThan(a.length);
    }
  });

  it("prefere fronteiras de parágrafo: parágrafos curtos não são cortados ao meio", () => {
    const paras = Array.from({ length: 10 }, (_, i) => paragraph(i, 198));
    const chunks = chunkText(paras.join("\n\n"));
    for (const p of paras) {
      expect(chunks.some((c) => c.includes(p))).toBe(true);
    }
  });

  it("texto vazio ou só com espaços não gera chunk; texto curto gera um chunk", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n \t\n")).toEqual([]);
    expect(chunkText("  Carteira: 500 ações PETR4 na XP  ")).toEqual([
      "Carteira: 500 ações PETR4 na XP",
    ]);
  });

  it("nunca devolve chunk vazio, mesmo com muitas linhas em branco e palavra gigante", () => {
    const text = `\n\n\n${"x".repeat(1900)}\n\n\n\n   \n\nfim`;
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.trim()).not.toBe("");
      expect(c.length).toBeLessThanOrEqual(800);
    }
    expect(chunks.join("")).toContain("fim");
  });

  it("aceita maxChars e overlap próprios e rejeita combinações inválidas", () => {
    const text = paragraph(1, 1000);
    const chunks = chunkText(text, { maxChars: 300, overlap: 50 });
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(() => chunkText(text, { maxChars: 100, overlap: 100 })).toThrow();
    expect(() => chunkText(text, { maxChars: 0 })).toThrow();
    expect(() => chunkText(text, { overlap: -1 })).toThrow();
  });
});
