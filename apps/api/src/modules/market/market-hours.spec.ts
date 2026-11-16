import { describe, expect, it } from "vitest";
import { marketStateAt } from "./market-hours.js";

// São Paulo é UTC-3: 10:00 local = 13:00Z. 2026-11-16 é segunda-feira.
const at = (iso: string) => Date.parse(iso);

describe("marketStateAt", () => {
  it("segunda 10:00 SP está aberto", () => {
    expect(marketStateAt(at("2026-11-16T13:00:00Z"))).toBe("open");
  });
  it("segunda 09:59 SP está fechado", () => {
    expect(marketStateAt(at("2026-11-16T12:59:00Z"))).toBe("closed");
  });
  it("segunda 17:59 SP está aberto", () => {
    expect(marketStateAt(at("2026-11-16T20:59:00Z"))).toBe("open");
  });
  it("segunda 18:00 SP está fechado", () => {
    expect(marketStateAt(at("2026-11-16T21:00:00Z"))).toBe("closed");
  });
  it("sábado 12:00 SP está fechado", () => {
    expect(marketStateAt(at("2026-11-14T15:00:00Z"))).toBe("closed");
  });
  it("domingo 12:00 SP está fechado", () => {
    expect(marketStateAt(at("2026-11-15T15:00:00Z"))).toBe("closed");
  });
  it("usa a data de São Paulo, não a UTC (segunda 01:00Z ainda é domingo)", () => {
    expect(marketStateAt(at("2026-11-16T01:00:00Z"))).toBe("closed");
  });
});
