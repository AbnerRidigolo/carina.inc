import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type CsvMapping, NormalizedTransactionSchema } from "@carina/shared";
import { CSV_PRESETS } from "./csv-presets.js";
import { parseCsv } from "./csv.js";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(
    readFileSync(new URL(`../../../../test/fixtures/imports/csv/${name}`, import.meta.url)),
  );
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const br = CSV_PRESETS.generico_br.mapping;
const plain: CsvMapping = {
  date: "Data",
  amount: "Valor",
  description: "Descrição",
  dateFormat: "dd/MM/yyyy",
  decimal: "comma",
  delimiter: ";",
};
const run = (bytes: Uint8Array, account = "123", mapping = plain) =>
  parseCsv(bytes, { mapping, institution: "Banco X", account });

describe("parseCsv", () => {
  it("lê o preset Nubank com Identificador como externalId", () => {
    const preset = CSV_PRESETS.nubank_conta;
    const r = parseCsv(fixture("nubank-conta.csv"), {
      mapping: preset.mapping,
      institution: preset.institution ?? "",
      account: "conta",
    });
    expect(r.failure).toBeUndefined();
    expect(r.transactions).toHaveLength(3);
    expect(r.transactions[0]).toMatchObject({
      externalId: "a1b2c3d4-0001-4000-8000-000000000001",
      institution: "Nubank",
      date: "2025-10-03",
      description: "Padaria São João",
      amountBrl: "150.00",
      kind: "debit",
    });
    expect(r.transactions[1]).toMatchObject({ kind: "credit", amountBrl: "3500.50" });
    expect(r.stats).toMatchObject({ rowsRead: 3, transactions: 3, errorRows: 0 });
    for (const t of r.transactions) {
      expect(NormalizedTransactionSchema.safeParse(t).success).toBe(true);
    }
  });

  it("genérico BR em UTF-8 e em windows-1252 dá o mesmo resultado", () => {
    const utf8 = run(fixture("generico-br.csv"), "123", br);
    const cp = run(fixture("generico-br-1252.csv"), "123", br);
    expect(utf8.failure).toBeUndefined();
    expect(utf8.transactions).toHaveLength(3);
    expect(utf8.transactions[0]).toMatchObject({
      amountBrl: "1234.56",
      kind: "debit",
      category: "Alimentação",
      description: "Padaria São João",
    });
    expect(utf8.transactions[2]).toMatchObject({ amountBrl: "89.90", kind: "debit" });
    expect(cp).toEqual(utf8);
  });

  it("trata aspas, aspas dobradas, delimitador e quebra de linha dentro de campo", () => {
    const r = run(fixture("aspas-e-quebras.csv"), "123", br);
    expect(r.transactions.map((t) => t.description)).toEqual([
      'Mercado; compras "do mês"',
      "Linha um\nlinha dois",
      "Depósito",
    ]);
    expect(r.stats.rowsRead).toBe(3);
  });

  it("numera a linha pelo registro físico (cabeçalho = 1)", () => {
    const r = run(enc('Data;Valor;Descrição\n01/01/2026;10,00;"a\nb"\n99/99/2026;10,00;x\n'), "1", {
      ...br,
      category: undefined,
    });
    expect(r.errors).toEqual([expect.objectContaining({ row: 3, code: "invalid_date" })]);
  });

  it("ambíguo.csv: 1,234.56 e 1,234 em vírgula viram ambiguous_amount; o claro passa", () => {
    const r = run(fixture("ambiguo.csv"), "123", br);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]?.amountBrl).toBe("10.50");
    expect(r.errors.map((e) => [e.row, e.code, e.field])).toEqual([
      [2, "ambiguous_amount", "amount"],
      [3, "ambiguous_amount", "amount"],
    ]);
    expect(r.stats.errorRows).toBe(2);
  });

  it.each([
    ["1.234,56", "comma", "1234.56"],
    ["-1.234,56", "comma", "-1234.56"],
    ["1234,56", "comma", "1234.56"],
    ["R$ 1.234,56", "comma", "1234.56"],
    ["1.234.567,8", "comma", "1234567.80"],
    ["1,234.56", "dot", "1234.56"],
    ["1234.5", "dot", "1234.50"],
  ] as const)("valor %s (%s) -> %s", (raw, decimal, expected) => {
    const r = run(enc(`Data;Valor;Descrição\n01/01/2026;"${raw}";x\n`), "1", {
      ...plain,
      decimal,
    });
    expect(r.transactions[0]?.amountBrl).toBe(expected.replace("-", ""));
    expect(r.transactions[0]?.kind).toBe(expected.startsWith("-") ? "debit" : "credit");
  });

  it.each([
    ["1,234.56", "comma", "ambiguous_amount"],
    ["1.234,567", "comma", "ambiguous_amount"],
    ["1.234", "dot", "ambiguous_amount"],
    ["1.234,56", "dot", "ambiguous_amount"],
    ["abc", "comma", "invalid_amount"],
    ["0,00", "comma", "invalid_amount"],
    ["1,2345", "comma", "invalid_amount"],
  ] as const)("recusa %s (%s) com %s", (raw, decimal, code) => {
    const r = run(enc(`Data;Valor;Descrição\n01/01/2026;"${raw}";x\n02/01/2026;5,00;ok\n`), "1", {
      ...plain,
      decimal,
    });
    expect(r.errors[0]).toMatchObject({ row: 2, code, field: "amount" });
  });

  it("data inexistente vira invalid_date", () => {
    const r = run(enc("Data;Valor;Descrição\n31/02/2026;10,00;x\n01/03/2026;10,00;y\n"));
    expect(r.errors).toEqual([expect.objectContaining({ row: 2, code: "invalid_date" })]);
    expect(r.transactions).toHaveLength(1);
  });

  it("coluna kind mapeada tem precedência sobre o sinal", () => {
    const r = run(
      enc(
        "Data;Valor;Descrição;Tipo\n01/01/2026;10,00;a;Débito\n01/01/2026;-10,00;b;CRÉDITO\n01/01/2026;5,00;c;outro\n",
      ),
      "1",
      { ...plain, kind: "Tipo" },
    );
    expect(r.transactions.map((t) => [t.kind, t.amountBrl])).toEqual([
      ["debit", "10.00"],
      ["credit", "10.00"],
    ]);
    expect(r.errors).toEqual([expect.objectContaining({ row: 4, code: "unknown_kind" })]);
  });

  it("externalId mapeado inválido vira erro de linha", () => {
    const r = parseCsv(
      enc("Data,Valor,Identificador,Descrição\n01/01/2026,1.00,​x,a\n01/01/2026,2.00,ok-1,b\n"),
      { mapping: CSV_PRESETS.nubank_conta.mapping, institution: "N", account: "1" },
    );
    expect(r.errors).toEqual([
      expect.objectContaining({ row: 2, code: "schema", field: "externalId" }),
    ]);
    expect(r.transactions[0]?.externalId).toBe("ok-1");
  });

  it("extrato sobreposto não duplica: ids derivados são estáveis entre arquivos", () => {
    const a = run(
      enc("Data;Valor;Descrição\n01/01/2026;-10,00;x\n01/01/2026;-10,00;x\n02/01/2026;5,00;y\n"),
    );
    const b = run(
      enc(
        "Data;Valor;Descrição\n01/01/2026;-10,00;x\n01/01/2026;-10,00;x\n02/01/2026;5,00;y\n03/01/2026;7,00;z\n",
      ),
    );
    const ids = (r: typeof a) => r.transactions.map((t) => t.externalId);
    expect(ids(a)).toEqual(ids(b).slice(0, 3));
    expect(new Set(ids(a)).size).toBe(3);
  });

  it("débito e crédito de mesmo valor, data e descrição têm ids distintos e estáveis", () => {
    const one = run(enc("Data;Valor;Descrição\n01/01/2026;-10,00;x\n01/01/2026;10,00;x\n"));
    const two = run(enc("Data;Valor;Descrição\n01/01/2026;10,00;x\n01/01/2026;-10,00;x\n"));
    const [d, c] = one.transactions;
    expect(d?.externalId).not.toBe(c?.externalId);
    expect(two.transactions.map((t) => t.externalId)).toEqual([c?.externalId, d?.externalId]);
  });

  it("contas diferentes não colidem", () => {
    const csv = enc("Data;Valor;Descrição\n01/01/2026;-10,00;x\n");
    expect(run(csv, "111").transactions[0]?.externalId).not.toBe(
      run(csv, "222").transactions[0]?.externalId,
    );
  });

  it("detecta o delimitador no cabeçalho quando o mapeamento não informa", () => {
    const r = run(enc('Data,Valor,Descrição\n01/01/2026,"10,00",x\n'), "1", {
      ...plain,
      delimiter: undefined,
    });
    expect(r.transactions).toHaveLength(1);
    const s = run(enc("Data;Valor;Descrição\n01/01/2026;10,00;x\n"), "1", {
      ...plain,
      delimiter: undefined,
    });
    expect(s.transactions).toHaveLength(1);
  });

  it("casa cabeçalho por nome exato após trim e NFC, aceita BOM e CRLF", () => {
    const nfd = "Descrição".normalize("NFD");
    const r = run(
      enc(`\ufeff Data ;Valor;${nfd};Categoria\r\n01/01/2026;10,00;x;c\r\n`),
      "123",
      br,
    );
    expect(r.failure).toBeUndefined();
    expect(r.transactions[0]).toMatchObject({ description: "x", category: "c" });
  });

  it("coluna do mapeamento ausente no cabeçalho -> unreadable", () => {
    const r = run(enc("Data;Valor;Histórico\n01/01/2026;10,00;x\n"));
    expect(r.failure).toBe("unreadable");
    expect(r.transactions).toEqual([]);
    expect(run(enc("")).failure).toBe("unreadable");
  });

  it("sem linhas válidas -> no_valid_rows com os erros", () => {
    const r = run(enc("Data;Valor;Descrição\n31/02/2026;10,00;x\n"));
    expect(r.failure).toBe("no_valid_rows");
    expect(r.errors).toHaveLength(1);
    expect(r.stats).toMatchObject({ rowsRead: 1, errorRows: 1 });
  });

  it("65 colunas -> limit_exceeded", () => {
    const header = Array.from({ length: 65 }, (_, i) => `c${i}`).join(";");
    expect(run(enc(`${header}\n`)).failure).toBe("limit_exceeded");
  });

  it("linha de 70 KB -> limit_exceeded", () => {
    const r = run(enc(`Data;Valor;Descrição\n01/01/2026;10,00;${"a".repeat(70 * 1024)}\n`));
    expect(r.failure).toBe("limit_exceeded");
  });

  it("mais de 100 000 linhas -> limit_exceeded", () => {
    const rows = "01/01/2026;1,00;x\n".repeat(100_001);
    expect(run(enc(`Data;Valor;Descrição\n${rows}`)).failure).toBe("limit_exceeded");
  });

  it("mensagens de erro nunca carregam conteúdo da linha", () => {
    const r = run(enc("Data;Valor;Descrição\n31/02/2026;SEGREDO;x\n01/01/2026;10,00;y\n"));
    expect(JSON.stringify(r.errors)).not.toContain("SEGREDO");
  });
});
