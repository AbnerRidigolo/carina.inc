import { describe, expect, it } from "vitest";
import { runParser } from "./parse-dispatch.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("runParser (despacho por formato, no próprio processo)", () => {
  it("CSV com mapeamento explícito usa instituição e conta das opções", () => {
    const r = runParser("csv", enc("d,v,h\n2025-10-01,-10.50,Mercado\n"), {
      format: "csv",
      institution: "Banco",
      account: "cc",
      csvMapping: {
        date: "d",
        amount: "v",
        description: "h",
        dateFormat: "yyyy-MM-dd",
        decimal: "dot",
      },
    });
    expect(r.transactions).toEqual([
      expect.objectContaining({ institution: "Banco", account: "cc", amountBrl: "10.50" }),
    ]);
  });

  it("CSV com preset", () => {
    const r = runParser(
      "csv",
      enc("Data;Valor;Descrição;Categoria\n01/10/2025;-10,00;Mercado;Casa\n"),
      {
        format: "csv",
        csvPreset: "generico_br",
        institution: "Banco",
        account: "cc",
      },
    );
    expect(r.transactions).toHaveLength(1);
  });

  it("B3: o despacho repassa os bytes ao parser da planilha", () => {
    expect(runParser("b3_xlsx", enc("x"), { format: "b3_xlsx" }).failure).toBe("unreadable");
  });

  it("formato e opções incoerentes → erro (não deveria acontecer: o upload valida)", () => {
    expect(() => runParser("csv", enc("x"), { format: "ofx" })).toThrow(TypeError);
    expect(() => runParser("b3_xlsx", enc("x"), { format: "ofx" })).toThrow(TypeError);
  });
});
