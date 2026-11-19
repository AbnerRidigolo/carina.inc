import { describe, expect, it } from "vitest";
import { sanitizeFileName } from "./file-name.js";

describe("sanitizeFileName", () => {
  it("fica só com o nome-base, com / ou \\", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\x\\extrato.ofx")).toBe("extrato.ofx");
    expect(sanitizeFileName("a/b\\c.csv")).toBe("c.csv");
  });
  it("remove controle e o override RTL", () => {
    expect(sanitizeFileName("a\u202Eb.csv")).toBe("ab.csv");
    expect(sanitizeFileName("a\u0000\n\tb.csv")).toBe("ab.csv");
  });
  it("normaliza em NFC e apara espaços", () => {
    expect(sanitizeFileName("  a\u0303.csv  ")).toBe("\u00e3.csv");
  });
  it("trunca em 120 caracteres (por caractere, não por unidade UTF-16)", () => {
    expect(sanitizeFileName("x".repeat(10 * 1024))).toHaveLength(120);
    expect(Array.from(sanitizeFileName("😀".repeat(200)))).toHaveLength(120);
  });
  it("vazio ou ausente vira arquivo", () => {
    expect(sanitizeFileName(undefined)).toBe("arquivo");
    expect(sanitizeFileName("")).toBe("arquivo");
    expect(sanitizeFileName("pasta/")).toBe("arquivo");
    expect(sanitizeFileName(" \u202E ")).toBe("arquivo");
  });
});
