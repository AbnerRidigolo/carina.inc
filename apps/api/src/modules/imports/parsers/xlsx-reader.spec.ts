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

  it("decodifica entidades predefinidas e numéricas em textos e nomes de planilha", () => {
    const sst = `<sst ${NS}><si><t>S&amp;P &lt;500&gt; &#233;&#xE9; &quot;x&apos;</t></si></sst>`;
    const sheet = `<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`;
    const wb = readWorkbook(
      zip({
        "xl/sharedStrings.xml": sst,
        "xl/worksheets/sheet1.xml": sheet,
        "xl/workbook.xml": WORKBOOK.replace('name="P"', 'name="A&amp;B"'),
      }),
    );
    expect(wb.sheets[0]?.name).toBe("A&B");
    expect(wb.sheets[0]?.rows).toEqual([["S&P <500> éé \"x'"]]);
  });

  it("originalSize mentiroso (declara menos do que infla) é recusado rápido", () => {
    const files = {
      "xl/workbook.xml": strToU8(WORKBOOK),
      "xl/_rels/workbook.xml.rels": strToU8(RELS),
      "xl/worksheets/sheet1.xml": new Uint8Array(30 * 1024 * 1024),
    };
    const bytes = zipSync(files, { level: 9 });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i + 46 < bytes.length; i++) {
      if (view.getUint32(i, true) !== 0x02014b50) continue;
      const nameLen = view.getUint16(i + 28, true);
      const name = new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + nameLen));
      if (name === "xl/worksheets/sheet1.xml") {
        view.setUint32(i + 24, view.getUint32(i + 20, true) * 100, true);
      }
    }
    const started = Date.now();
    expect(() => readWorkbook(bytes)).toThrow(ImportLimitError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("muitos <sheet> apontando para a mesma planilha são recusados", () => {
    const sheets = Array.from(
      { length: 1000 },
      (_, i) => `<sheet name="P${i}" sheetId="${i + 1}" r:id="rId1"/>`,
    ).join("");
    const wb = `<workbook ${NS} ${REL}><sheets>${sheets}</sheets></workbook>`;
    expect(() => readWorkbook(zip({ "xl/workbook.xml": wb }))).toThrow(
      /ImportLimit|Xlsx|limite|ilegível/i,
    );
  });

  /** Zip com 3 entradas fixas + sheet1 por último; devolve também onde começa o diretório central. */
  function zipComSheetGrande() {
    let seed = 1;
    const pad = `<!--${Array.from({ length: 1024 * 1024 }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed >> 16).toString(16).slice(-1);
    }).join("")}-->`;
    const bytes = zipSync(
      {
        "xl/workbook.xml": strToU8(WORKBOOK),
        "xl/_rels/workbook.xml.rels": strToU8(RELS),
        "xl/worksheets/sheet1.xml": strToU8(SHEET + pad),
      },
      { level: 9 },
    );
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = bytes.length - 22;
    return { bytes, view, eocd, cd: view.getUint32(eocd + 16, true) };
  }

  it("entradas locais duplicadas escondidas fora do diretório central não são inflaladas", () => {
    const { bytes, view, eocd, cd } = zipComSheetGrande();
    // Primeiro registro do diretório central cujo nome é sheet1 (a última entrada local).
    let off = 0;
    for (let p = cd; p < eocd;) {
      const n = view.getUint16(p + 28, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + n));
      if (name === "xl/worksheets/sheet1.xml") off = view.getUint32(p + 42, true);
      p += 46 + n + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    }
    const entry = bytes.subarray(off, cd);
    const copies = 50;
    const out = new Uint8Array(bytes.length + entry.length * copies);
    out.set(bytes.subarray(0, cd), 0);
    for (let k = 0; k < copies; k++) out.set(entry, cd + k * entry.length);
    const newCd = cd + copies * entry.length;
    out.set(bytes.subarray(cd), newCd);
    new DataView(out.buffer).setUint32(newCd + (eocd - cd) + 16, newCd, true);
    const started = Date.now();
    expect(readWorkbook(out).sheets[0]?.rows).toEqual([[1]]);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("tamanho comprimido falsificado além do buffer → XlsxUnreadableError", () => {
    const { bytes, view, eocd, cd } = zipComSheetGrande();
    for (let p = cd; p < eocd;) {
      const n = view.getUint16(p + 28, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + n));
      if (name === "xl/worksheets/sheet1.xml") view.setUint32(p + 20, 0x7fffffff, true);
      p += 46 + n + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    }
    expect(() => readWorkbook(bytes)).toThrow(XlsxUnreadableError);
  });

  it("nomes duplicados no diretório central → XlsxUnreadableError", () => {
    const bytes = zip({ "xl/worksheets/sheet2.xml": SHEET });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = bytes.length - 22;
    for (let p = view.getUint32(eocd + 16, true); p < eocd;) {
      const n = view.getUint16(p + 28, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + n));
      if (name === "xl/worksheets/sheet2.xml")
        bytes.set(strToU8("xl/worksheets/sheet1.xml"), p + 46);
      p += 46 + n + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    }
    expect(() => readWorkbook(bytes)).toThrow(XlsxUnreadableError);
  });
});
