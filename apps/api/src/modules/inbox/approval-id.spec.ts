import { describe, expect, it } from "vitest";
import { approvalId, stableStringify } from "./approval-id.js";

describe("approvalId", () => {
  it("é sha256 hex (64 caracteres)", () => {
    expect(approvalId("t", "place_trade", { a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("não muda com a ordem das chaves, em qualquer profundidade", () => {
    const a = approvalId("t", "place_trade", {
      symbol: "PETR4",
      qty: 10,
      meta: { x: 1, y: [{ b: 2, a: 1 }] },
    });
    const b = approvalId("t", "place_trade", {
      meta: { y: [{ a: 1, b: 2 }], x: 1 },
      qty: 10,
      symbol: "PETR4",
    });
    expect(a).toBe(b);
  });

  it("muda quando um valor, a ação ou o thread muda", () => {
    const base = approvalId("t", "place_trade", { qty: 10 });
    expect(approvalId("t", "place_trade", { qty: 11 })).not.toBe(base);
    expect(approvalId("t", "transfer", { qty: 10 })).not.toBe(base);
    expect(approvalId("u", "place_trade", { qty: 10 })).not.toBe(base);
  });

  it("a ordem de um array importa", () => {
    expect(approvalId("t", "a", { l: [1, 2] })).not.toBe(approvalId("t", "a", { l: [2, 1] }));
  });
});

describe("stableStringify", () => {
  it("ordena chaves recursivamente e preserva arrays", () => {
    expect(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });
});
