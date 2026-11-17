// Gera os .xlsx de teste (sem dados reais): `node gerar.mjs` nesta pasta.
import { writeFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function pacote(sheets, sharedStrings) {
  const files = {
    "[Content_Types].xml": strToU8(
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    ),
    "xl/workbook.xml": strToU8(
      `${XML}<workbook ${NS} ${REL}><sheets>${sheets
        .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join("")}</Relationships>`,
    ),
  };
  if (sharedStrings) {
    files["xl/sharedStrings.xml"] = strToU8(
      `${XML}<sst ${NS}>${sharedStrings.map((t) => `<si><t>${t}</t></si>`).join("")}</sst>`,
    );
  }
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `${XML}<worksheet ${NS}><sheetData>${s.rows}</sheetData></worksheet>`,
    );
  });
  return zipSync(files);
}

const simples = pacote(
  [
    {
      name: "Posição",
      rows:
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>100</v></c></row>' +
        '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3" t="n"><v>50.5</v></c></row>',
    },
    {
      name: "Outros",
      rows:
        '<row r="1"><c r="A1" t="inlineStr"><is><t>texto</t></is></c><c r="C1" t="b"><v>1</v></c></row>' +
        '<row r="3"><c r="B3" t="b"><v>0</v></c></row>',
    },
  ],
  ["Produto", "Quantidade", "PETR4", "VALE3"],
);

const formulaComCache = pacote([
  {
    name: "Plan1",
    rows: '<row r="1"><c r="A1"><v>2</v></c><c r="B1"><v>3</v></c><c r="C1"><f>A1+B1</f><v>5</v></c></row>',
  },
]);

const formulaSemCache = pacote([
  {
    name: "Plan1",
    rows: '<row r="1"><c r="A1"><v>2</v></c><c r="B1"><v>3</v></c><c r="C1"><f>A1+B1</f></c></row>',
  },
]);

writeFileSync("simples.xlsx", simples);
writeFileSync("formula-com-cache.xlsx", formulaComCache);
writeFileSync("formula-sem-cache.xlsx", formulaSemCache);
