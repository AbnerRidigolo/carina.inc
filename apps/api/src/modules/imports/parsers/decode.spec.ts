import { describe, expect, it } from "vitest";
import { decodeText } from "./decode.js";

describe("decodeText", () => {
  const utf8 = new TextEncoder().encode("Pão");
  const win = new Uint8Array([0x50, 0xe3, 0x6f]);

  it("decodifica UTF-8", () => {
    expect(decodeText(utf8)).toBe("Pão");
  });

  it("cai para windows-1252 quando não é UTF-8 válido", () => {
    expect(decodeText(win)).toBe("Pão");
  });

  it("remove o BOM UTF-8", () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]))).toBe("Pão");
  });

  it("hint força a codificação", () => {
    expect(decodeText(win, "windows-1252")).toBe("Pão");
    expect(decodeText(utf8, "utf-8")).toBe("Pão");
    expect(decodeText(utf8, "windows-1252")).toBe("PÃ£o");
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]), "utf-8")).toBe("A");
  });
});
