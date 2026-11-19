import type { NormalizedTransaction } from "@carina/shared";
import { describe, expect, it } from "vitest";
import { categorize, withInferredCategories } from "./categorize.js";

const tx = (over: Partial<NormalizedTransaction> = {}): NormalizedTransaction => ({
  externalId: "t1",
  institution: "Itaú",
  account: "cc",
  date: "2026-11-01",
  description: "texto sem regra",
  amountBrl: "-10.00",
  kind: "debit",
  ...over,
});

describe("categorize", () => {
  it.each([
    ["FARMÁCIA em NFD → saúde", "FARMÁCIA Popular".normalize("NFD"), "debit", "saúde"],
    ["Imposto de renda → impostos", "Imposto de renda", "debit", "impostos"],
    ["IOF compra internacional → impostos", "IOF compra internacional", "debit", "impostos"],
    ["Posto Ipiranga → transporte", "Posto Ipiranga", "debit", "transporte"],
    ["Mercado Livre não é alimentação", "Mercado Livre", "debit", null],
    ["Mercado Pago não é alimentação", "Mercado Pago", "debit", null],
    ["mercado financeiro não é alimentação", "mercado financeiro", "debit", null],
    ["Supermercado Extra → alimentação", "Supermercado Extra", "debit", "alimentação"],
    ["Uberlândia não casa uber", "Uberlândia", "debit", null],
    ["Uber Eats segue transporte", "Uber Eats", "debit", "transporte"],
    ["aguardando não casa agua", "Pagamento aguardando", "debit", null],
    ["Uber*Trip → transporte", "Uber*Trip", "debit", "transporte"],
    ["Corrida 99 → transporte", "Corrida 99", "debit", "transporte"],
    ["R$ 199,00 não casa 99", "Pagamento R$ 199,00", "debit", null],
    ["dividend sem descrição útil → investimento", "Proventos", "dividend", "investimento"],
    ["buy → investimento", "Compra", "buy", "investimento"],
    ["sell → investimento", "Venda", "sell", "investimento"],
    ["jcp → investimento", "JCP", "jcp", "investimento"],
    ["tax → impostos", "IOF", "tax", "impostos"],
    ["fee → tarifas", "Tarifa mensal", "fee", "tarifas"],
    ["Aluguel de março → moradia", "Aluguel de março", "debit", "moradia"],
    ["Conta de luz → moradia (palavra curta com limite)", "Conta de luz", "debit", "moradia"],
    ["'luz' dentro de outra palavra não casa", "Luzia Maria", "debit", null],
    ["kind vence a descrição", "Supermercado", "tax", "impostos"],
    ["texto sem regra → null", "Padaria São João", "debit", null],
  ] as const)("%s", (_t, description, kind, expected) => {
    expect(categorize(description, kind)).toBe(expected);
  });
});

describe("withInferredCategories", () => {
  it("mantém a categoria enviada e não inventa 'outros'", () => {
    const out = withInferredCategories([
      tx({ externalId: "a", description: "Uber", category: "viagens" }),
      tx({ externalId: "b", description: "Uber" }),
      tx({ externalId: "c", description: "Uber", category: "" }),
      tx({ externalId: "d" }),
      tx({ externalId: "e", description: "Uber", category: "   " }),
    ]);
    expect(out.map((i) => i.category)).toEqual([
      "viagens",
      "transporte",
      "transporte",
      undefined,
      "transporte",
    ]);
    expect("category" in (out[3] ?? {})).toBe(false);
  });
});
