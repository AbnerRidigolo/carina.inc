// Gera os .xlsx de teste (sem dados reais, rodado à mão, não no CI): `node gerar.mjs` nesta pasta.
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

// --- Planilhas da Área do Investidor B3 (dados fictícios) ---

const esc = (t) => String(t).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const COLS = "ABCDEFGHIJ";

/** Linhas a partir de matrizes: string → texto, número → número, { f } → fórmula sem valor em cache. */
function linhas(matriz) {
  return matriz
    .map(
      (cells, r) =>
        `<row r="${r + 1}">` +
        cells
          .map((v, c) => {
            const ref = `${COLS[c]}${r + 1}`;
            if (v === null) return "";
            if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
            if (typeof v === "object") return `<c r="${ref}"><f>${esc(v.f)}</f></c>`;
            return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
          })
          .join("") +
        "</row>",
    )
    .join("");
}

const aba = (name, matriz) => ({ name: esc(name), rows: linhas(matriz) });

const posCab = ["Produto", "Instituição", "Código de Negociação", "Quantidade", "Valor Atualizado"];
const acoes = aba("Acoes", [
  posCab,
  ["PETR4 - PETROBRAS PN", "XP INVESTIMENTOS CCTVM S/A", "PETR4", 100, 3850.5],
  ["VALE3 - VALE ON", "XP INVESTIMENTOS CCTVM S/A", "VALE3", 50, "R$ 3.100,00"],
]);
const fundos = aba("Fundo de Investimento", [
  posCab,
  ["HGLG11 - CSHG LOGISTICA FII", "XP INVESTIMENTOS CCTVM S/A", "HGLG11", 10, 1650],
  ["FUNDO ALFA MULTIMERCADO", "XP INVESTIMENTOS CCTVM S/A", null, 12.5, 2500.75],
]);
const tesouro = aba("Tesouro Direto", [
  ["Produto", "Instituição", "Quantidade", "Valor Atualizado"],
  ["Tesouro Selic 2029", "Banco do Brasil", 1.45, 20500.1],
]);
const renda = aba("Renda Fixa", [
  ["Produto", "Instituição", "Quantidade", "Valor Atualizado"],
  ["CDB BANCO BETA 2027", "Banco Beta", 3, 3300],
]);

const movCab = [
  "Entrada/Saída",
  "Data",
  "Movimentação",
  "Produto",
  "Instituição",
  "Quantidade",
  "Preço unitário",
  "Valor da Operação",
];
const mov = aba("Movimentação", [
  movCab,
  ["Credito", "10/10/2025", "Dividendo", "PETR4 - PETROBRAS PN", "XP", 100, 0.5, "R$ 50,00"],
  ["Credito", "15/10/2025", "Juros Sobre Capital Próprio", "VALE3 - VALE ON", "XP", 50, 0.8, 40],
  ["Credito", "20/10/2025", "Rendimento", "HGLG11 - CSHG LOGISTICA FII", "XP", 10, 1.1, "R$ 11,00"],
  [
    "Credito",
    "21/10/2025",
    "Transferência - Liquidação",
    "PETR4 - PETROBRAS PN",
    "XP",
    10,
    30,
    300,
  ],
  ["Debito", "22/10/2025", "Transferência - Liquidação", "VALE3 - VALE ON", "XP", 5, 60, 300],
  ["Credito", "23/10/2025", "Bonificação em Ativos", "VALE3 - VALE ON", "XP", 5, 0, 0],
]);

const negCab = [
  "Data do Negócio",
  "Tipo de Movimentação",
  "Instituição",
  "Código de Negociação",
  "Quantidade",
  "Preço",
  "Valor",
];
const negLinhas = [
  ["02/10/2025", "Compra", "XP", "PETR4", 100, 38.5, "R$ 3.850,00"],
  [45962, "Venda", "XP", "VALE3", 20, 62, 1240],
  ["03/10/2025", "Compra", "XP", "PETR4", 100, 38.5, "R$ 3.850,00"],
];
const neg = aba("Negociação", [negCab, ...negLinhas]);

const tresAbas = pacote([acoes, mov, neg]);

writeFileSync("b3-posicao.xlsx", pacote([acoes, fundos, tesouro, renda]));
writeFileSync("b3-movimentacao.xlsx", pacote([mov]));
writeFileSync("b3-negociacao.xlsx", pacote([neg]));
writeFileSync("b3-tres-abas.xlsx", tresAbas);
writeFileSync("b3-aba-desconhecida.xlsx", pacote([neg, aba("Resumo", [["Total"], [1]])]));
// Segunda exportação, sobreposta à primeira: 2 linhas repetidas + 1 nova.
writeFileSync(
  "b3-negociacao-sobreposta.xlsx",
  pacote([
    aba("Negociação", [
      negCab,
      negLinhas[1],
      negLinhas[2],
      ["04/11/2025", "Venda", "XP", "PETR4", 50, 40, 2000],
    ]),
  ]),
);
writeFileSync(
  "b3-formula.xlsx",
  pacote([
    aba("Negociação", [
      negCab,
      ["02/10/2025", "Compra", "XP", "PETR4", 100, 38.5, { f: "E2*F2" }],
      negLinhas[1],
    ]),
  ]),
);
writeFileSync(
  "b3-mil-posicoes.xlsx",
  pacote([
    aba("Acoes", [
      posCab,
      ...Array.from({ length: 1001 }, (_, i) => [
        `ATIVO ${i}`,
        "XP",
        `AT${String(i).padStart(4, "0")}`,
        1,
        10,
      ]),
    ]),
  ]),
);
