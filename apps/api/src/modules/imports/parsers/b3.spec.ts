import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NormalizedPositionSchema, NormalizedTransactionSchema } from "@carina/shared";
import { parseB3 } from "./b3.js";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(
    readFileSync(new URL(`../../../../test/fixtures/imports/xlsx/${name}`, import.meta.url)),
  );
const ASOF = "2025-11-14";

describe("parseB3", () => {
  it("lê a aba de Posição e mapeia as classes de ativo", () => {
    const r = parseB3(fixture("b3-posicao.xlsx"), { asOf: ASOF });
    expect(r.failure).toBeUndefined();
    expect(r.errors).toEqual([]);
    expect(r.transactions).toEqual([]);
    expect(
      r.positions.map((p) => [p.name, p.assetClass, p.assetCode, p.quantity, p.valueBrl]),
    ).toEqual([
      ["PETR4 - PETROBRAS PN", "acao", "PETR4", "100", "3850.50"],
      ["VALE3 - VALE ON", "acao", "VALE3", "50", "3100.00"],
      ["HGLG11 - CSHG LOGISTICA FII", "fii", "HGLG11", "10", "1650.00"],
      ["FUNDO ALFA MULTIMERCADO", "fundo", undefined, "12.5", "2500.75"],
      ["Tesouro Selic 2029", "tesouro", undefined, "1.45", "20500.10"],
      ["CDB BANCO BETA 2027", "renda_fixa", undefined, "3", "3300.00"],
    ]);
    for (const p of r.positions) {
      expect(NormalizedPositionSchema.safeParse(p).success).toBe(true);
      expect(p).toMatchObject({ kind: "investment", asOf: ASOF });
      expect(p.externalId).toMatch(/^b3:pos:[0-9a-f]{64}$/);
    }
    expect(r.positionInstitutions).toEqual([
      "XP INVESTIMENTOS CCTVM S/A",
      "Banco do Brasil",
      "Banco Beta",
    ]);
    expect(r.stats).toMatchObject({ rowsRead: 6, positions: 6, transactions: 0, errorRows: 0 });
  });

  it("posição sem asOf falha com missing_as_of", () => {
    const r = parseB3(fixture("b3-posicao.xlsx"), {});
    expect(r.failure).toBe("missing_as_of");
    expect(r.positions).toEqual([]);
  });

  it("mesma posição em duas fotografias mantém o externalId", () => {
    const a = parseB3(fixture("b3-posicao.xlsx"), { asOf: "2025-10-01" });
    const b = parseB3(fixture("b3-posicao.xlsx"), { asOf: "2025-11-01" });
    expect(a.positions.map((p) => p.externalId)).toEqual(b.positions.map((p) => p.externalId));
    expect(new Set(a.positions.map((p) => p.externalId)).size).toBe(a.positions.length);
  });

  it("lê a Movimentação: proventos viram transações e o resto é ignorado e contado", () => {
    const r = parseB3(fixture("b3-movimentacao.xlsx"), {});
    expect(r.failure).toBeUndefined();
    expect(r.positions).toEqual([]);
    expect(
      r.transactions.map((t) => [t.date, t.kind, t.amountBrl, t.account, t.institution]),
    ).toEqual([
      ["2025-10-10", "dividend", "50.00", "B3", "XP"],
      ["2025-10-15", "jcp", "40.00", "B3", "XP"],
      ["2025-10-20", "dividend", "11.00", "B3", "XP"],
    ]);
    for (const t of r.transactions) {
      expect(NormalizedTransactionSchema.safeParse(t).success).toBe(true);
      expect(t.externalId).toMatch(/^b3:movimentacao:[0-9a-f]+$/);
    }
    expect(r.stats.ignored).toEqual({
      "transferencia - liquidacao": 2,
      "bonificacao em ativos": 1,
    });
    expect(r.stats.rowsRead).toBe(6);
  });

  it("lê a Negociação, com data serial do Excel", () => {
    const r = parseB3(fixture("b3-negociacao.xlsx"), {});
    expect(r.failure).toBeUndefined();
    expect(r.errors).toEqual([]);
    expect(
      r.transactions.map((t) => [t.date, t.kind, t.assetCode, t.quantity, t.amountBrl]),
    ).toEqual([
      ["2025-10-02", "buy", "PETR4", "100", "3850.00"],
      ["2025-11-01", "sell", "VALE3", "20", "1240.00"],
      ["2025-10-03", "buy", "PETR4", "100", "3850.00"],
    ]);
  });

  it("negociação sobreposta em duas exportações gera os mesmos ids", () => {
    const a = parseB3(fixture("b3-negociacao.xlsx"), {});
    const b = parseB3(fixture("b3-negociacao-sobreposta.xlsx"), {});
    expect(b.transactions).toHaveLength(3);
    expect(b.transactions.slice(0, 2).map((t) => t.externalId)).toEqual(
      a.transactions.slice(1).map((t) => t.externalId),
    );
    expect(new Set([...a.transactions, ...b.transactions].map((t) => t.externalId)).size).toBe(4);
  });

  it("lê as três abas juntas", () => {
    const r = parseB3(fixture("b3-tres-abas.xlsx"), { asOf: ASOF });
    expect(r.failure).toBeUndefined();
    expect(r.positions).toHaveLength(2);
    expect(r.transactions).toHaveLength(6);
    expect(r.positionInstitutions).toEqual(["XP INVESTIMENTOS CCTVM S/A"]);
    expect(r.stats).toMatchObject({ positions: 2, transactions: 6, errorRows: 0 });
    expect(r.stats.ignored).toEqual({
      "transferencia - liquidacao": 2,
      "bonificacao em ativos": 1,
    });
  });

  it("conta a aba desconhecida em stats.ignored", () => {
    const r = parseB3(fixture("b3-aba-desconhecida.xlsx"), {});
    expect(r.failure).toBeUndefined();
    expect(r.transactions).toHaveLength(3);
    expect(r.stats.ignored).toEqual({ "aba:resumo": 1 });
  });

  it("fórmula sem valor em cache vira erro da linha, sem conteúdo", () => {
    const r = parseB3(fixture("b3-formula.xlsx"), {});
    expect(r.transactions).toHaveLength(1);
    expect(r.errors).toEqual([
      {
        row: 2,
        field: "Valor",
        code: "formula_without_value",
        message: "Célula com fórmula sem valor calculado.",
      },
    ]);
    expect(r.stats.errorRows).toBe(1);
  });

  it("1001 posições estouram o limite", () => {
    const r = parseB3(fixture("b3-mil-posicoes.xlsx"), { asOf: ASOF });
    expect(r.failure).toBe("limit_exceeded");
    expect(r.positions).toEqual([]);
  });

  it("arquivo sem aba reconhecida ou que não é XLSX falha com unreadable", () => {
    expect(parseB3(fixture("simples.xlsx"), { asOf: ASOF }).failure).toBe("unreadable");
    expect(parseB3(new TextEncoder().encode("não é zip"), {}).failure).toBe("unreadable");
  });

  it("zip além dos limites falha com limit_exceeded", () => {
    // 51 entradas no diretório central: o leitor recusa antes de inflar.
    const eocd = new Uint8Array(22);
    const v = new DataView(eocd.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(10, 51, true);
    expect(parseB3(eocd, {}).failure).toBe("limit_exceeded");
  });
});
