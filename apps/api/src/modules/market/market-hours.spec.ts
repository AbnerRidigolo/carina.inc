import { describe, expect, it } from "vitest";
import { marketStateAt, saoPauloDate } from "./market-hours.js";

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

describe("saoPauloDate", () => {
  it("devolve a data de São Paulo em YYYY-MM-DD", () => {
    expect(saoPauloDate(at("2026-11-16T13:00:00Z"))).toBe("2026-11-16");
    expect(saoPauloDate(at("2026-01-05T15:00:00Z"))).toBe("2026-01-05");
  });
  it("vira o dia à meia-noite de São Paulo, não à UTC", () => {
    expect(saoPauloDate(at("2026-11-17T02:59:59Z"))).toBe("2026-11-16");
    expect(saoPauloDate(at("2026-11-17T03:00:00Z"))).toBe("2026-11-17");
  });
});
