import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ImportLimitError } from "./types.js";
import { readWorkbook, XlsxUnreadableError } from "./xlsx-reader.js";

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`../../../../test/fixtures/imports/xlsx/${name}`, import.meta.url)),
  );

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const WORKBOOK = `<workbook ${NS} ${REL}><sheets><sheet name="P" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const RELS =
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>';
const SHEET = `<worksheet ${NS}><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`;

function zip(extra: Record<string, string> = {}, level: 0 | 9 = 0): Uint8Array {
  const base: Record<string, string> = {
    "xl/workbook.xml": WORKBOOK,
    "xl/_rels/workbook.xml.rels": RELS,
    "xl/worksheets/sheet1.xml": SHEET,
  };
  const files: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries({ ...base, ...extra })) files[k] = strToU8(v);
  return zipSync(files, { level });
}

describe("readWorkbook", () => {
  it("lê nomes das planilhas e linhas (strings, números, inline, booleanos e vazios)", () => {
    const wb = readWorkbook(fixture("simples.xlsx"));
    expect(wb.sheets.map((s) => s.name)).toEqual(["Posição", "Outros"]);
    expect(wb.sheets[0]?.rows).toEqual([
      ["Produto", "Quantidade"],
      ["PETR4", 100],
      ["VALE3", 50.5],
    ]);
    expect(wb.sheets[1]?.rows).toEqual([["texto", null, "TRUE"], [], [null, "FALSE"]]);
  });

  it("fórmula com valor em cache devolve o valor", () => {
    const wb = readWorkbook(fixture("formula-com-cache.xlsx"));
    expect(wb.sheets[0]?.rows).toEqual([[2, 3, 5]]);
  });

  it("fórmula sem cache devolve o marcador", () => {
    const wb = readWorkbook(fixture("formula-sem-cache.xlsx"));
    expect(wb.sheets[0]?.rows).toEqual([[2, 3, { formulaWithoutValue: true }]]);
  });

  it("zip bomb (entrada que declara 60 MB) é recusado como limite", () => {
    const bomb = zipSync(
      { "xl/worksheets/sheet1.xml": new Uint8Array(60 * 1024 * 1024) },
      { level: 9 },
    );
    expect(() => readWorkbook(bomb)).toThrow(ImportLimitError);
  });

  it("razão de compressão acima de 200 é recusada", () => {
    const bomb = zip({ "xl/worksheets/sheet2.xml": "<a>".repeat(1_000_000) }, 9);
    expect(() => readWorkbook(bomb)).toThrow(ImportLimitError);
  });

  it("51 entradas → ImportLimitError", () => {
    const extra: Record<string, string> = {};
    for (let i = 0; i < 47; i++) extra[`extra/${i}.txt`] = "x";
    expect(() => readWorkbook(zip(extra))).not.toThrow(); // 3 + 47 = 50 entradas
    extra["extra/47.txt"] = "x";
    expect(() => readWorkbook(zip(extra))).toThrow(ImportLimitError);
  });

  it("XML com <!DOCTYPE → XlsxUnreadableError", () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]>${SHEET}`;
    expect(() => readWorkbook(zip({ "xl/worksheets/sheet1.xml": evil }))).toThrow(
      XlsxUnreadableError,
    );
  });

  it("XML com <!ENTITY sem DOCTYPE no workbook → XlsxUnreadableError", () => {
    expect(() => readWorkbook(zip({ "xl/workbook.xml": `<!ENTITY a "b">${WORKBOOK}` }))).toThrow(
      XlsxUnreadableError,
    );
  });

  it("zip sem xl/workbook.xml → XlsxUnreadableError", () => {
    const bytes = zipSync({ "a.txt": strToU8("oi") });
    expect(() => readWorkbook(bytes)).toThrow(XlsxUnreadableError);
  });

  it("bytes que não são zip → XlsxUnreadableError", () => {
    expect(() => readWorkbook(strToU8("não sou zip"))).toThrow(XlsxUnreadableError);
  });

  it("não descompacta entradas fora da lista permitida", () => {
    const bytes = zip({ "docProps/lixo.xml": "<<<nem é xml>>>" });
    expect(readWorkbook(bytes).sheets[0]?.rows).toEqual([[1]]);
  });
});
