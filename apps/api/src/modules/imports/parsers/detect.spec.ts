import { readFileSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { detectFormat } from "./detect.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("detectFormat", () => {
  it("reconhece OFX SGML pelo cabeçalho", () => {
    expect(detectFormat(enc("OFXHEADER:100\nDATA:OFXSGML\n\n<OFX>"))).toBe("ofx");
  });

  it("reconhece OFX XML com BOM e espaços", () => {
    const body = enc('\n  <?OFX OFXHEADER="200"?>\n<OFX></OFX>');
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
    expect(detectFormat(bytes)).toBe("ofx");
  });

  it("reconhece OFX só pela tag <OFX>", () => {
    expect(detectFormat(enc("<OFX><SIGNONMSGSRSV1/></OFX>"))).toBe("ofx");
  });

  it("reconhece XLSX com [Content_Types].xml e xl/workbook.xml", () => {
    const zip = zipSync({
      "[Content_Types].xml": strToU8("<x/>"),
      "xl/workbook.xml": strToU8("<x/>"),
    });
    expect(detectFormat(zip)).toBe("b3_xlsx");
  });

  it("zip com dados de entrada corrompidos mas diretório central válido ainda detecta b3_xlsx", () => {
    const zip = zipSync(
      {
        "[Content_Types].xml": [strToU8("<x/>".repeat(200)), { level: 9 }],
        "xl/workbook.xml": [strToU8("<x/>".repeat(200)), { level: 9 }],
      },
      { level: 9 },
    );
    // Estraga o início dos dados da primeira entrada (cabeçalho local tem 30 bytes + nome).
    const start = 30 + "[Content_Types].xml".length;
    for (let i = start; i < start + 8; i++) zip[i] = 0xff;
    expect(detectFormat(zip)).toBe("b3_xlsx");
  });

  it("rejeita zip sem xl/workbook.xml", () => {
    const zip = zipSync({ "[Content_Types].xml": strToU8("<x/>"), "a.txt": strToU8("oi") });
    expect(detectFormat(zip)).toBeNull();
  });

  it("rejeita zip truncado", () => {
    const zip = zipSync({ "a.txt": strToU8("oi") });
    expect(detectFormat(zip.slice(0, 10))).toBeNull();
  });

  it("reconhece CSV com ; e com ,", () => {
    expect(detectFormat(enc("a;b;c\n1;2;3\n4;5;6\n"))).toBe("csv");
    expect(detectFormat(enc("a,b,c\n1,2,3\n"))).toBe("csv");
  });

  it("rejeita tab como delimitador (o parser só aceita ; e ,)", () => {
    expect(detectFormat(enc("a\tb\n1\t2\n"))).toBeNull();
  });

  it("reconhece CSV com quebra de linha dentro de aspas", () => {
    const fixture = new URL(
      "../../../../test/fixtures/imports/csv/aspas-e-quebras.csv",
      import.meta.url,
    );
    expect(detectFormat(readFileSync(fixture))).toBe("csv");
  });

  it("amostra cortada no meio de um registro entre aspas ainda é CSV", () => {
    // O 2º registro começa entre aspas e passa do fim da amostra de 64 KB: cortado, teria 1 coluna.
    const row = '"' + "linha\n".repeat(7_000) + '";1\n';
    expect(detectFormat(enc("a;b\n" + row + row))).toBe("csv");
  });

  it("ignora delimitador dentro de aspas", () => {
    expect(detectFormat(enc('"a;b";c\n"1;2";3\n'))).toBe("csv");
  });

  it("rejeita texto com colunas inconsistentes", () => {
    expect(detectFormat(enc("a;b;c\n1;2\n"))).toBeNull();
  });

  it("rejeita texto de uma coluna só", () => {
    expect(detectFormat(enc("olá mundo\nsegunda linha\n"))).toBeNull();
  });

  it("rejeita binário com NUL", () => {
    expect(detectFormat(new Uint8Array([1, 0, 2, 59, 3, 10]))).toBeNull();
  });

  it("rejeita vazio e texto vazio", () => {
    expect(detectFormat(new Uint8Array())).toBeNull();
    expect(detectFormat(enc("\n\n"))).toBeNull();
  });

  it("reconhece CSV em windows-1252", () => {
    const bytes = new Uint8Array([0x50, 0xe3, 0x6f, 0x3b, 0x31, 0x0a, 0x61, 0x3b, 0x32, 0x0a]);
    expect(detectFormat(bytes)).toBe("csv");
  });
});
