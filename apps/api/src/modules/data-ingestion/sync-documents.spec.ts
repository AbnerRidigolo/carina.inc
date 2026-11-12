import type { NormalizedPosition, NormalizedTransaction } from "@carina/shared";
import { describe, expect, it } from "vitest";
import {
  CashFlowAggregator,
  PortfolioAggregator,
  TOP_POSITIONS,
  cashFlowWindow,
  compareCodePoints,
  formatBrl,
  formatPercent,
  formatQuantity,
  normalizeDescription,
  parseCents,
  parseInstalment,
  percentTenths,
} from "./sync-documents.js";

const pos = (p: Partial<NormalizedPosition>): NormalizedPosition => ({
  externalId: "p",
  institution: "XP",
  kind: "investment",
  assetClass: "acao",
  name: "Ativo",
  valueBrl: "0.00",
  asOf: "2026-11-10",
  ...p,
});

const txn = (t: Partial<NormalizedTransaction>): NormalizedTransaction => ({
  externalId: "t",
  institution: "Itaú",
  account: "cc",
  date: "2026-11-10",
  description: "Lançamento",
  amountBrl: "-1.00",
  kind: "debit",
  ...t,
});

describe("dinheiro em pt-BR (aritmética exata, sem Number nem Intl)", () => {
  it("parseCents lê decimais de até 2 casas", () => {
    expect(parseCents("0")).toBe(0n);
    expect(parseCents("0.00")).toBe(0n);
    expect(parseCents("-0.00")).toBe(0n);
    expect(parseCents("1.5")).toBe(150n);
    expect(parseCents("-0.05")).toBe(-5n);
    expect(parseCents("15000.00")).toBe(1_500_000n);
    expect(parseCents("9999999999999999.99")).toBe(999_999_999_999_999_999n);
    for (const bad of ["", "1,00", "1.234", "abc", "1e3", "--1", " 1"]) {
      expect(() => parseCents(bad), bad).toThrow(RangeError);
    }
  });

  it("formatBrl: zero, centavos, milhar, 16 dígitos e negativos", () => {
    expect(formatBrl(0n)).toBe("R$ 0,00");
    expect(formatBrl(5n)).toBe("R$ 0,05");
    expect(formatBrl(99n)).toBe("R$ 0,99");
    expect(formatBrl(100n)).toBe("R$ 1,00");
    expect(formatBrl(99_999n)).toBe("R$ 999,99");
    expect(formatBrl(100_000n)).toBe("R$ 1.000,00");
    expect(formatBrl(1_500_000n)).toBe("R$ 15.000,00");
    expect(formatBrl(123_456_789n)).toBe("R$ 1.234.567,89");
    expect(formatBrl(999_999_999_999_999_999n)).toBe("R$ 9.999.999.999.999.999,99");
    expect(formatBrl(-5n)).toBe("-R$ 0,05");
    expect(formatBrl(-123_456n)).toBe("-R$ 1.234,56");
  });

  it("formatQuantity: separadores pt-BR e sem zeros à direita", () => {
    expect(formatQuantity("500")).toBe("500");
    expect(formatQuantity("1234.50000000")).toBe("1.234,5");
    expect(formatQuantity("0.00000001")).toBe("0,00000001");
    expect(formatQuantity("1000000.25")).toBe("1.000.000,25");
    expect(formatQuantity("-3.0")).toBe("-3");
  });
});

describe("percentuais (décimos de ponto percentual, arredondamento half up)", () => {
  it("arredonda meio para cima", () => {
    expect(percentTenths(1n, 3n)).toBe(333n); // 33,33…
    expect(percentTenths(2n, 3n)).toBe(667n); // 66,66…
    expect(percentTenths(1n, 8n)).toBe(125n); // 12,5 exato
    expect(percentTenths(1n, 2000n)).toBe(1n); // 0,05 → 0,1
    expect(percentTenths(1n, 2001n)).toBe(0n); // 0,0499… → 0,0
    expect(percentTenths(-1n, 2000n)).toBe(0n); // -0,05 → 0,0 (para cima)
    expect(percentTenths(-3n, 2000n)).toBe(-1n); // -0,15 → -0,1
    expect(percentTenths(5n, 5n)).toBe(1000n);
  });
  it("total não positivo é erro", () => {
    expect(() => percentTenths(1n, 0n)).toThrow(RangeError);
  });
  it("formatPercent", () => {
    expect(formatPercent(0n)).toBe("0,0%");
    expect(formatPercent(1n)).toBe("0,1%");
    expect(formatPercent(201n)).toBe("20,1%");
    expect(formatPercent(1000n)).toBe("100,0%");
    expect(formatPercent(-1n)).toBe("-0,1%");
  });
});

describe("ordem e normalização independentes de collation", () => {
  it("compareCodePoints compara por ponto de código", () => {
    const sorted = ["b", "B", "a", "é", "e", "Z", "😀", "￿"].sort(compareCodePoints);
    expect(sorted).toEqual(["B", "Z", "a", "b", "e", "é", "￿", "😀"]);
  });
  it("normalizeDescription: caixa, acentos e espaços", () => {
    expect(normalizeDescription("  Aluguel  e\tCondomínio ")).toBe("aluguel e condominio");
    expect(normalizeDescription("ALUGUEL E CONDOMINIO")).toBe("aluguel e condominio");
  });
  it("parseInstalment reconhece séries de parcelas", () => {
    expect(parseInstalment("Notebook - parcela 3/10")).toEqual({
      base: "notebook",
      index: 3,
      count: 10,
    });
    expect(parseInstalment("Geladeira 02/12")).toEqual({ base: "geladeira", index: 2, count: 12 });
    expect(parseInstalment("Sofá parcela 4 de 6")).toEqual({ base: "sofa", index: 4, count: 6 });
    expect(parseInstalment("Aluguel e condomínio")).toBeNull();
    expect(parseInstalment("Parcela 11/10")).toBeNull(); // índice maior que o total
    expect(parseInstalment("Compra 1/1")).toBeNull(); // à vista
  });
});

describe("PortfolioAggregator (Carteira consolidada)", () => {
  it("uma linha por posição, alocação por classe, entidades e relações", () => {
    const agg = new PortfolioAggregator();
    agg.add(pos({ assetCode: "PETR4", name: "Petrobras PN", quantity: "500", valueBrl: "15000" }));
    agg.add(
      pos({
        assetClass: "tesouro",
        name: "Tesouro Selic 2029",
        institution: "BTG",
        valueBrl: "5000.00",
      }),
    );
    const doc = agg.build();
    expect(doc?.title).toBe("Carteira consolidada");
    expect(doc?.text).toContain("500 PETR4 (ação) na XP: R$ 15.000,00");
    expect(doc?.text).toContain("Tesouro Selic 2029 (tesouro) na BTG: R$ 5.000,00");
    expect(doc?.text).toContain("patrimônio total R$ 20.000,00");
    expect(doc?.text).toContain("Classe acao (ação): 75,0% do patrimônio, R$ 15.000,00");
    expect(doc?.text).toContain("Classe tesouro (tesouro): 25,0% do patrimônio, R$ 5.000,00");
    expect(doc?.text).toContain("todas as fontes");
    // a maior posição vem antes
    expect(doc?.text.indexOf("PETR4")).toBeLessThan(doc?.text.indexOf("Tesouro Selic") ?? 0);

    const refs = doc?.entities.map((e) => `${e.type}:${e.name}`);
    expect(refs).toEqual(
      expect.arrayContaining([
        "ativo:PETR4",
        "ativo:Tesouro Selic 2029",
        "instituicao:XP",
        "instituicao:BTG",
        "classe:acao",
        "classe:tesouro",
        "cliente:self",
      ]),
    );
    expect(doc?.relations).toEqual(
      expect.arrayContaining([
        { sourceRef: "ativo:PETR4", targetRef: "instituicao:XP", type: "CUSTODIADO_EM" },
        { sourceRef: "ativo:PETR4", targetRef: "classe:acao", type: "DA_CLASSE" },
        { sourceRef: "cliente:self", targetRef: "ativo:PETR4", type: "POSSUI" },
      ]),
    );
    expect(doc?.mentions).not.toContain("cliente:self");
  });

  it("soma o mesmo ativo vindo de fontes diferentes (não deduplica)", () => {
    const agg = new PortfolioAggregator();
    agg.add(pos({ externalId: "a", assetCode: "PETR4", quantity: "100", valueBrl: "3850.00" }));
    agg.add(pos({ externalId: "a", assetCode: "PETR4", quantity: "50.5", valueBrl: "1944.25" }));
    const doc = agg.build();
    expect(doc?.text).toContain("150,5 PETR4 (ação) na XP: R$ 5.794,25");
  });

  it(`lista só as ${TOP_POSITIONS} maiores e resume as demais; texto determinístico`, () => {
    const build = (reverse: boolean) => {
      const agg = new PortfolioAggregator();
      const items = Array.from({ length: TOP_POSITIONS + 5 }, (_, i) =>
        pos({ assetCode: `AT${String(i).padStart(3, "0")}`, valueBrl: `${i + 1}.00` }),
      );
      for (const p of reverse ? items.reverse() : items) agg.add(p);
      return agg.build();
    };
    const doc = build(false);
    expect(doc?.text).toContain("Demais 5 posições: R$ 15,00.");
    expect(doc?.text).not.toContain("AT000 ");
    expect(doc?.text).toContain("AT034");
    expect(build(true)?.text).toBe(doc?.text);
    expect(doc?.entities.filter((e) => e.type === "ativo")).toHaveLength(TOP_POSITIONS);
  });

  it("sem posições não gera documento", () => {
    expect(new PortfolioAggregator().build()).toBeNull();
  });
});

describe("CashFlowAggregator (Fluxo de caixa 12 meses)", () => {
  it("janela de 12 meses civis até o mês da transação mais recente", () => {
    expect(cashFlowWindow("2026-11-10")).toEqual({
      from: "2025-12-01",
      months: [
        "2025-12",
        "2026-01",
        "2026-02",
        "2026-03",
        "2026-04",
        "2026-05",
        "2026-06",
        "2026-07",
        "2026-08",
        "2026-09",
        "2026-10",
        "2026-11",
      ],
    });
    expect(cashFlowWindow("2026-01-31").from).toBe("2025-02-01");
  });

  it("entradas = soma dos positivos; saídas = |soma dos negativos| (sinal de amountBrl)", () => {
    const agg = new CashFlowAggregator("2026-11-30");
    agg.add(txn({ date: "2026-11-01", amountBrl: "1000.00", kind: "credit" }));
    agg.add(txn({ date: "2026-11-02", amountBrl: "10.50", kind: "dividend" }));
    agg.add(txn({ date: "2026-11-03", amountBrl: "-300.25", kind: "debit", category: "moradia" }));
    agg.add(txn({ date: "2026-11-04", amountBrl: "-200.00", kind: "buy", category: "aporte" }));
    agg.add(txn({ date: "2026-10-04", amountBrl: "-0.01", kind: "fee", category: "tarifas" }));
    // fora da janela: ignorada
    agg.add(txn({ date: "2025-11-30", amountBrl: "-999.00" }));
    const doc = agg.build();
    expect(doc?.title).toBe("Fluxo de caixa 12 meses");
    expect(doc?.text).toContain("Entradas: R$ 1.010,50. Saídas: R$ 500,26. Saldo: R$ 510,24.");
    expect(doc?.text).toContain(
      "Mês 2026-11: entradas R$ 1.010,50, saídas R$ 500,25, saldo R$ 510,25.",
    );
    expect(doc?.text).toContain("Mês 2026-10: entradas R$ 0,00, saídas R$ 0,01, saldo -R$ 0,01.");
    expect(doc?.text).toContain("Mês 2025-12: entradas R$ 0,00, saídas R$ 0,00, saldo R$ 0,00.");
    // compra de ativo é saída de caixa mas não é categoria de despesa
    expect(doc?.text).toContain("Categoria moradia: R$ 300,25 em 1 lançamento.");
    expect(doc?.text).not.toContain("Categoria aporte");
    expect(doc?.entities.map((e) => `${e.type}:${e.name}`)).toEqual(
      expect.arrayContaining(["categoria:moradia", "categoria:tarifas"]),
    );
  });

  it("top 5 categorias de despesa por valor", () => {
    const agg = new CashFlowAggregator("2026-11-30");
    ["a", "b", "c", "d", "e", "f"].forEach((c, i) =>
      agg.add(txn({ amountBrl: `-${i + 1}.00`, category: c })),
    );
    const text = agg.build()?.text ?? "";
    expect(text).toContain("1. Categoria f: R$ 6,00");
    expect(text).toContain("5. Categoria b: R$ 2,00");
    expect(text).not.toContain("Categoria a:");
  });

  it("recorrência = mesma descrição normalizada em ≥ 3 meses distintos", () => {
    const agg = new CashFlowAggregator("2026-11-30");
    for (const date of ["2026-11-05", "2026-10-05", "2026-09-05"]) {
      agg.add(txn({ date, description: "Plano de Saúde", category: "saúde" }));
    }
    // 2 vezes no mesmo mês + 1 em outro: só 2 meses distintos, não é recorrência
    for (const date of ["2026-11-01", "2026-11-20", "2026-10-01"]) {
      agg.add(txn({ date, description: "Padaria" }));
    }
    agg.add(txn({ date: "2026-08-05", description: "PLANO DE SAUDE " }));
    const text = agg.build()?.text ?? "";
    expect(text).toContain('Recorrência "Plano de Saúde": 4 meses, 4 lançamentos');
    expect(text).not.toContain('Recorrência "Padaria"');
  });

  it("parcelamentos agrupados por série; parcelas não contam como recorrência", () => {
    const agg = new CashFlowAggregator("2026-11-30");
    for (let k = 1; k <= 4; k++) {
      agg.add(
        txn({
          date: `2026-${String(7 + k).padStart(2, "0")}-10`,
          description: `Notebook - parcela ${k}/10`,
          amountBrl: "-450.00",
          category: "compras",
        }),
      );
    }
    const text = agg.build()?.text ?? "";
    expect(text).toContain(
      'Parcelamento "Notebook" em 10x: 4 parcelas no período (1 a 4), total -R$ 1.800,00.',
    );
    expect(text).not.toContain('Recorrência "Notebook');
  });

  it("sem transações não gera documento", () => {
    expect(new CashFlowAggregator("2026-11-30").build()).toBeNull();
  });
});
