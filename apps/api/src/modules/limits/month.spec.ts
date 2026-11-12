import { describe, expect, it } from "vitest";
import { monthKey, monthRange } from "./month.js";

describe("monthKey (America/Sao_Paulo)", () => {
  it("vira o mês à meia-noite de São Paulo (03:00 UTC), não à meia-noite UTC", () => {
    expect(monthKey(Date.UTC(2026, 0, 31, 23, 59, 59))).toBe("2026-01");
    expect(monthKey(Date.UTC(2026, 1, 1, 2, 59, 59))).toBe("2026-01");
    expect(monthKey(Date.UTC(2026, 1, 1, 3, 0, 0))).toBe("2026-02");
  });
});

describe("monthRange", () => {
  it("devolve [início, fim) do mês em São Paulo", () => {
    expect(monthRange("2026-02")).toEqual({
      startMs: Date.UTC(2026, 1, 1, 3),
      endMs: Date.UTC(2026, 2, 1, 3),
    });
  });

  it("dezembro termina em 1º de janeiro do ano seguinte", () => {
    expect(monthRange("2026-12")).toEqual({
      startMs: Date.UTC(2026, 11, 1, 3),
      endMs: Date.UTC(2027, 0, 1, 3),
    });
  });

  it("usa o deslocamento da época (horário de verão de 2018: -02:00 em 1º de janeiro)", () => {
    expect(monthRange("2018-01")?.startMs).toBe(Date.UTC(2018, 0, 1, 2));
  });

  it("rejeita meses inválidos", () => {
    for (const bad of ["2026-13", "2026-00", "2026-1", "26-01", "2026/01", "", "2026-01-01"])
      expect(monthRange(bad)).toBeUndefined();
  });
});
