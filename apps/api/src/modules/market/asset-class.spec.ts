import { describe, expect, it } from "vitest";
import { inferAssetClass, SYMBOL_RE } from "./asset-class.js";

describe("inferAssetClass", () => {
  it.each([
    ["PETR4", "stock"],
    ["PETR3", "stock"],
    ["AAPL34", "bdr"],
    ["HGLG11", "fund"],
    ["^BVSP", "index"],
    ["ABCD", "unknown"],
  ] as const)("%s -> %s", (symbol, expected) => {
    expect(inferAssetClass(symbol)).toBe(expected);
  });
});

describe("SYMBOL_RE", () => {
  it.each(["PETR4", "^BVSP", "AAPL34", "A"])("aceita %s", (s) => {
    expect(SYMBOL_RE.test(s)).toBe(true);
  });
  it.each(["petr4", "PETR4/x", "", "ABCDEFGHIJKLM"])("recusa %j", (s) => {
    expect(SYMBOL_RE.test(s)).toBe(false);
  });
});
