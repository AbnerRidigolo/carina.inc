import { describe, expect, it } from "vitest";
import { requestIdFrom } from "./logging.module.js";

const UUID = /^[0-9a-f-]{36}$/;

describe("requestIdFrom (x-request-id do cliente)", () => {
  it("aceita um id curto de caracteres seguros", () => {
    expect(requestIdFrom("abc-123_X.y:z")).toBe("abc-123_X.y:z");
    expect(requestIdFrom("a".repeat(128))).toBe("a".repeat(128));
  });

  it("gera um uuid novo se ausente, vazio, longo demais, com caractere inseguro ou repetido", () => {
    for (const bad of [
      undefined,
      "",
      "a".repeat(129),
      "id com espaço",
      "x\nforjado",
      "<script>",
      "ç",
      ["a", "b"],
    ]) {
      expect(requestIdFrom(bad as string | string[] | undefined), String(bad)).toMatch(UUID);
    }
  });
});
