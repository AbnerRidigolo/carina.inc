import { describe, expect, it } from "vitest";
import { deriveExternalId, OccurrenceCounter } from "./external-id.js";

describe("deriveExternalId", () => {
  it("é estável", () => {
    expect(deriveExternalId("csv", ["a", "b"], 0)).toBe(deriveExternalId("csv", ["a", "b"], 0));
    expect(deriveExternalId("csv", ["a", "b"], 0)).toMatch(/^csv:[0-9a-f]{64}$/);
  });

  it("ocorrência, partes ou prefixo diferentes mudam o id", () => {
    const base = deriveExternalId("csv", ["a", "b"], 0);
    expect(deriveExternalId("csv", ["a", "b"], 1)).not.toBe(base);
    expect(deriveExternalId("csv", ["a", "c"], 0)).not.toBe(base);
    expect(deriveExternalId("csv", ["ab"], 0)).not.toBe(base);
  });

  it("cabe em 128 com prefixo longo", () => {
    const id = deriveExternalId("p".repeat(100), ["x"], 0);
    expect(id.length).toBeLessThanOrEqual(128);
    expect(id.startsWith(`${"p".repeat(100)}:`)).toBe(true);
  });
});

describe("OccurrenceCounter", () => {
  it("conta por chave", () => {
    const c = new OccurrenceCounter();
    expect([c.next("a"), c.next("a"), c.next("b"), c.next("a")]).toEqual([0, 1, 0, 2]);
  });
});
