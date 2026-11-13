import { describe, expect, it } from "vitest";
import { formatBootError } from "./boot-error.js";

describe("formatBootError", () => {
  it("devolve a stack (com a mensagem) de um Error", () => {
    const err = new Error("falhou o connect");
    const out = formatBootError(err);
    expect(out).toContain("Error: falhou o connect");
    expect(out).toContain("boot-error.spec.ts");
  });

  it("inclui a cadeia de `cause` com as stacks", () => {
    const root = new TypeError("ECONNREFUSED 127.0.0.1:5432");
    const err = new Error("Falha ao conectar no Postgres", { cause: root });
    const out = formatBootError(err);
    expect(out).toContain("Falha ao conectar no Postgres");
    expect(out).toMatch(/Caused by: TypeError: ECONNREFUSED 127\.0\.0\.1:5432\n\s+at /);
  });

  it("valor que não é Error vira texto; ciclos de cause não travam", () => {
    expect(formatBootError("texto")).toBe("texto");
    expect(formatBootError({ code: 1 })).toBe('{"code":1}');
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(formatBootError(b).match(/Caused by/g)?.length).toBeLessThanOrEqual(5);
  });
});
