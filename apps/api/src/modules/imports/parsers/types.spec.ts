import { describe, expect, it } from "vitest";
import { ImportLimitError, PARSE_LIMITS } from "./types.js";

describe("types", () => {
  it("ImportLimitError carrega o código", () => {
    const e = new ImportLimitError("x");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("limit_exceeded");
  });

  it("limites do spec", () => {
    expect(PARSE_LIMITS).toEqual({
      maxRows: 100_000,
      maxColumns: 64,
      maxLineBytes: 65_536,
      maxUnzippedBytes: 52_428_800,
      maxZipEntries: 50,
      maxPositions: 1000,
      maxStoredErrors: 100,
      parseTimeoutMs: 30_000,
    });
  });
});
