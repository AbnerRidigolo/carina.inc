import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NormalizedTransactionSchema } from "@carina/shared";
import { parseOfx } from "./ofx.js";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(
    readFileSync(new URL(`../../../../test/fixtures/imports/ofx/${name}`, import.meta.url)),
  );
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function stmt(trns: string, extra = ""): Uint8Array {
  return enc(
    `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nCHARSET:NONE\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>${extra}<BANKACCTFROM><BANKID>1<ACCTID>2</BANKACCTFROM><BANKTRANSLIST>${trns}</BANKTRANSLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
  );
}

describe("parseOfx", () => {
  it("lê SGML windows-1252 com acentos e instituição do ORG", () => {
    const r = parseOfx(fixture("conta-sgml-1252.ofx"));
    expect(r.failure).toBeUndefined();
    expect(r.transactions).toHaveLength(3);
    expect(r.transactions.map((t) => t.description)).toEqual([
      "Padaria São João",
      "Salário outubro",
      "Conta de luz",
    ]);
    expect(r.transactions[0]).toMatchObject({
      institution: "Banco Exemplo",
      account: "12345-6",
      date: "2025-10-03",
      amountBrl: "150.00",
      kind: "debit",
    });
    expect(r.transactions[1]).toMatchObject({ kind: "credit", amountBrl: "3500.50" });
    expect(r.transactions[2]).toMatchObject({ amountBrl: "89.90" });
    expect(r.stats).toMatchObject({ rowsRead: 3, transactions: 3, errorRows: 0 });
    for (const t of r.transactions)
      expect(NormalizedTransactionSchema.safeParse(t).success).toBe(true);
  });

  it("XML UTF-8 dá o mesmo resultado que o SGML", () => {
    const a = parseOfx(fixture("conta-sgml-1252.ofx"));
    const b = parseOfx(fixture("conta-xml-utf8.ofx"));
    expect(b.transactions).toEqual(a.transactions);
  });

  it("cartão marca débito e crédito pelo sinal; instituição cai para BANKID ou OFX", () => {
    const r = parseOfx(fixture("cartao-sgml.ofx"));
    expect(r.transactions.map((t) => t.kind)).toEqual(["debit", "credit"]);
    expect(r.transactions[0]?.institution).toBe("OFX");
    expect(r.transactions[0]?.account).toBe("4000000000001111");
    const bank = parseOfx(
      stmt("<STMTTRN><DTPOSTED>20250101<TRNAMT>-1.00<FITID>X<MEMO>m</STMTTRN>"),
    );
    expect(bank.transactions[0]?.institution).toBe("1");
  });

  it("investimento é recusado", () => {
    const r = parseOfx(fixture("investimento.ofx"));
    expect(r.failure).toBe("unsupported_ofx_investment");
    expect(r.transactions).toEqual([]);
  });

  it("extrato sobreposto não duplica: mesmos externalId nas transações comuns", () => {
    const a = parseOfx(fixture("sobreposto-out.ofx"));
    const b = parseOfx(fixture("sobreposto-out-nov.ofx"));
    expect(b.transactions).toHaveLength(3);
    expect(b.transactions.slice(0, 2).map((t) => t.externalId)).toEqual(
      a.transactions.map((t) => t.externalId),
    );
  });

  it("sem FITID, linhas idênticas viram ids diferentes e estáveis", () => {
    const r = parseOfx(fixture("sem-fitid.ofx"));
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]?.externalId).not.toBe(r.transactions[1]?.externalId);
    expect(parseOfx(fixture("sem-fitid.ofx")).transactions).toEqual(r.transactions);
  });

  it("sem FITID, débito e crédito de mesmo valor e descrição têm ids distintos e estáveis entre extratos sobrepostos", () => {
    const deb = "<STMTTRN><DTPOSTED>20250105<TRNAMT>-5.00<MEMO>Estorno</STMTTRN>";
    const cred = "<STMTTRN><DTPOSTED>20250105<TRNAMT>5.00<MEMO>Estorno</STMTTRN>";
    const a = parseOfx(stmt(deb + cred)).transactions;
    const b = parseOfx(stmt(cred)).transactions;
    expect(a[0]?.externalId).not.toBe(a[1]?.externalId);
    expect(b[0]?.externalId).toBe(a[1]?.externalId);
  });

  it("TRNAMT com ponto e milhar vírgula é ambíguo, na linha certa", () => {
    const r = parseOfx(
      stmt(
        "<STMTTRN><DTPOSTED>20250101<TRNAMT>-1.00<FITID>A<MEMO>a</STMTTRN>" +
          "<STMTTRN><DTPOSTED>20250101<TRNAMT>1.234,56<FITID>B<MEMO>b</STMTTRN>",
      ),
    );
    expect(r.transactions).toHaveLength(1);
    expect(r.errors).toEqual([
      expect.objectContaining({ row: 2, field: "TRNAMT", code: "ambiguous_amount" }),
    ]);
    expect(r.stats.errorRows).toBe(1);
  });

  it("valores e datas inválidos viram erros de linha", () => {
    const r = parseOfx(
      stmt(
        "<STMTTRN><DTPOSTED>20250101<TRNAMT>1.005<FITID>A<MEMO>a</STMTTRN>" +
          "<STMTTRN><DTPOSTED>20251301<TRNAMT>1.00<FITID>B<MEMO>b</STMTTRN>" +
          "<STMTTRN><DTPOSTED>20250101<FITID>C<MEMO>c</STMTTRN>" +
          "<STMTTRN><DTPOSTED>20250101<TRNAMT>0.00<FITID>D<MEMO>d</STMTTRN>" +
          "<STMTTRN><DTPOSTED>20250102<TRNAMT>2,50<FITID>E<MEMO>e</STMTTRN>",
      ),
    );
    expect(r.errors.map((e) => [e.row, e.code])).toEqual([
      [1, "invalid_amount"],
      [2, "invalid_date"],
      [3, "missing_field"],
      [4, "invalid_amount"],
    ]);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]).toMatchObject({ amountBrl: "2.50", kind: "credit" });
  });

  it("sem nenhuma transação válida", () => {
    const r = parseOfx(stmt("<STMTTRN><DTPOSTED>x<TRNAMT>1.00<FITID>A<MEMO>a</STMTTRN>"));
    expect(r.failure).toBe("no_valid_rows");
    expect(r.errors).toHaveLength(1);
  });

  it("texto que não é OFX", () => {
    expect(parseOfx(enc("nome;valor\nfoo;1")).failure).toBe("unreadable");
  });

  it("100 001 transações estouram o limite", () => {
    const one = "<STMTTRN><DTPOSTED>20250101<TRNAMT>1.00<FITID>A<MEMO>a</STMTTRN>";
    const r = parseOfx(stmt(one.repeat(100_001)));
    expect(r.failure).toBe("limit_exceeded");
  });
});
