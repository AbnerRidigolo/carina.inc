import { describe, expect, it } from "vitest";
import { ValidationError } from "../../core/errors/domain-errors.js";
import { EVAL_DATASET, type EvalCase } from "./dataset.js";
import { catalog, evaluate, gradeCase, normalize, round4 } from "./grading.js";

const caso: EvalCase = {
  id: "t",
  category: "tributacao",
  difficulty: "medium",
  question: "q?",
  expectedFacts: [
    { description: "alíquota 22,5%", alternatives: ["22.5"] },
    { description: "isenção", alternatives: ["isen"] },
  ],
  forbidden: [{ description: "27,5% (errado)", alternatives: ["27.5"] }],
  reference: "norma",
};

describe("normalize", () => {
  it("tira acentos, minúsculas, vírgula decimal vira ponto e colapsa espaços", () => {
    expect(normalize("Isenção de 22,5%  ao ANO")).toBe("isencao de 22.5% ao ano");
  });

  it("NFD e vírgula decimal casam a alternativa", () => {
    const nfd = "Isenção: aliquota de 22,5%".normalize("NFD");
    const r = gradeCase(caso, nfd);
    expect(r.matched).toEqual(["alíquota 22,5%", "isenção"]);
    expect(r.passed).toBe(true);
  });
});

describe("gradeCase", () => {
  it("resposta correta passa", () => {
    const r = gradeCase(caso, "Há isenção até o limite; acima, a alíquota é de 22,5%.");
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.missing).toEqual([]);
  });

  it("resposta incompleta lista os fatos faltantes", () => {
    const r = gradeCase(caso, "A alíquota é de 22,5%.");
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0.5);
    expect(r.missing).toEqual(["isenção"]);
  });

  it("afirmação proibida reprova mesmo com fatos corretos", () => {
    const r = gradeCase(caso, "Isenção até o limite; acima, 22,5% — ou seria 27,5%?");
    expect(r.passed).toBe(false);
    expect(r.forbiddenHits).toEqual(["27,5% (errado)"]);
  });

  it("violação de compliance é flagrada", () => {
    const r = gradeCase(caso, "Isenção garantida e retorno garantido de 22,5%!");
    expect(r.complianceFlags.some((f) => f.code === "suitability.certainty_claim")).toBe(true);
  });

  it("caso real acoes-isencao-20k", () => {
    const report = evaluate({
      "acoes-isencao-20k":
        "Não paga: vendas de até R$ 20.000 no mês em operações comuns são isentas de IR para pessoa física.",
    });
    expect(report.passed).toBe(1);
    expect(report.passRate).toBe(1);
  });

  it("arredonda a 4 casas (1/3 vira 0.3333)", () => {
    const tres: EvalCase = {
      ...caso,
      expectedFacts: [
        { description: "a", alternatives: ["aaa"] },
        { description: "b", alternatives: ["bbb"] },
        { description: "c", alternatives: ["ccc"] },
      ],
    };
    expect(gradeCase(tres, "aaa").score).toBe(0.3333);
  });
});

describe("round4", () => {
  it("imita o round(x, 4) do Python, inclusive empates exatos (para o par)", () => {
    expect(round4(0.03125)).toBe(0.0312);
    expect(round4(0.09375)).toBe(0.0938);
    expect(round4(0.00005)).toBe(0.0001);
    expect(round4(2 / 3)).toBe(0.6667);
    expect(round4(1)).toBe(1);
    expect(round4(0)).toBe(0);
  });
});

describe("catalog", () => {
  it("não vaza gabarito nem referência", () => {
    for (const entry of catalog()) {
      expect(Object.keys(entry).sort()).toEqual(["category", "difficulty", "id", "question"]);
    }
    expect(catalog()).toHaveLength(EVAL_DATASET.length);
  });

  it("filtra por categoria", () => {
    const cvm = catalog("cvm");
    expect(cvm.length).toBeGreaterThan(0);
    expect(cvm.every((e) => e.category === "cvm")).toBe(true);
  });
});

describe("evaluate", () => {
  it("agrega por categoria e permite execução parcial", () => {
    const report = evaluate({
      "lci-lca": "LCI e LCA são isentas de IR para pessoa física.",
      ptax: "É a taxa de referência do dólar divulgada pelo Banco Central.",
      "copom-selic": "Quem define é o governo, todo mês.",
    });
    expect(report.answered).toBe(3);
    expect(report.passed).toBe(2);
    expect(report.byCategory.tributacao?.passed).toBe(1);
    expect(report.byCategory.macro?.answered).toBe(2);
    expect(report.byCategory.macro?.passed).toBe(1);
    expect(report.results.map((r) => r.caseId)).toEqual(["copom-selic", "lci-lca", "ptax"]);
  });

  it("caso inexistente lança ValidationError com os ids", () => {
    expect(() => evaluate({ "nao-existe": "x", "outro-id": "y" })).toThrow(ValidationError);
    expect(() => evaluate({ "nao-existe": "x", "outro-id": "y" })).toThrow(/nao-existe, outro-id/);
  });

  it("o erro de caso inexistente não carrega o texto das respostas", () => {
    try {
      evaluate({ "nao-existe": "SEGREDO-DA-RESPOSTA" });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("SEGREDO-DA-RESPOSTA");
    }
  });
});

/**
 * Paridade com o Python 3 (legacy/python/carina/data_engine/evaluation.py::EvalCase.grade).
 * Os resultados esperados foram gerados rodando o Python sobre estas respostas; os testes não
 * precisam do Python. Flags de compliance: só os códigos (a forma da flag é coberta em
 * watchtower/inspect-text.parity.spec.ts).
 */
interface ParityRow {
  label: string;
  caseId: string;
  answer: string;
  expected: {
    score: number;
    passed: boolean;
    matched: string[];
    missing: string[];
    forbiddenHits: string[];
    flagCodes: string[];
  };
}

const PARITY: readonly ParityRow[] = [
  {
    label: "terceira parcial sem fatos",
    caseId: "fgc-cobertura",
    answer: "O FGC garante depósitos até R$ 250.000 por instituição.",
    expected: {
      score: 0.3333,
      passed: false,
      matched: ["R$ 250 mil por CPF por instituição/conglomerado"],
      missing: ["teto global de R$ 1 milhão", "janela de 4 anos para o teto global"],
      forbiddenHits: [],
      flagCodes: [],
    },
  },
  {
    label: "correta simples",
    caseId: "acoes-aliquota-swing",
    answer: "A alíquota é de 15% sobre o ganho líquido.",
    expected: {
      score: 1.0,
      passed: true,
      matched: ["alíquota de 15%"],
      missing: [],
      forbiddenHits: [],
      flagCodes: [],
    },
  },
  {
    label: "proibida com fato correto",
    caseId: "acoes-aliquota-swing",
    answer: "São 15%, e não 27,5% como na tabela progressiva.",
    expected: {
      score: 1.0,
      passed: false,
      matched: ["alíquota de 15%"],
      missing: [],
      forbiddenHits: ["confusão com a tabela progressiva (27,5%)"],
      flagCodes: [],
    },
  },
  {
    label: "parcial",
    caseId: "day-trade",
    answer: "O day trade paga 20% de IR sobre o lucro.",
    expected: {
      score: 0.5,
      passed: false,
      matched: ["alíquota de 20%"],
      missing: ["retenção de 1% na fonte (dedo-duro)"],
      forbiddenHits: [],
      flagCodes: [],
    },
  },
  {
    label: "fatos acentuados em NFD",
    caseId: "come-cotas",
    answer: "O come-cotas antecipa o IR de fundos em maio e novembro.",
    expected: {
      score: 1.0,
      passed: true,
      matched: ["antecipação/recolhimento periódico de IR", "ocorre em maio", "ocorre em novembro"],
      missing: [],
      forbiddenHits: [],
      flagCodes: [],
    },
  },
  {
    label: "vazia/errada",
    caseId: "copom-selic",
    answer: "Quem define é o governo, todo mês.",
    expected: {
      score: 0.0,
      passed: false,
      matched: [],
      missing: ["definida pelo Copom", "a cada 45 dias (8 reuniões/ano)"],
      forbiddenHits: [],
      flagCodes: [],
    },
  },
  {
    label: "compliance e virgula",
    caseId: "fgc-cobertura",
    answer:
      "Cobre R$ 250 mil por CPF, teto global de 1 milhão em 4 anos. Retorno garantido, você deve comprar CDB!",
    expected: {
      score: 1.0,
      passed: true,
      matched: [
        "R$ 250 mil por CPF por instituição/conglomerado",
        "teto global de R$ 1 milhão",
        "janela de 4 anos para o teto global",
      ],
      missing: [],
      forbiddenHits: [],
      flagCodes: ["suitability.certainty_claim", "cvm.unauthorized_recommendation"],
    },
  },
  {
    label: "alternativa com acento e caixa",
    caseId: "ptax",
    answer: "A PTAX é a taxa de CÂMBIO divulgada pelo Banco Central do Brasil.",
    expected: {
      score: 1.0,
      passed: true,
      matched: ["taxa de câmbio (referência do dólar)", "calculada/divulgada pelo Banco Central"],
      missing: [],
      forbiddenHits: [],
      flagCodes: [],
    },
  },
];

describe("paridade com o Python", () => {
  it.each(PARITY.map((p) => [p.label, p] as const))("%s", (_label, row) => {
    const caseDef = EVAL_DATASET.find((c) => c.id === row.caseId);
    if (!caseDef) throw new Error(`caso ${row.caseId} ausente do dataset`);
    const r = gradeCase(caseDef, row.answer);
    expect({
      score: r.score,
      passed: r.passed,
      matched: r.matched,
      missing: r.missing,
      forbiddenHits: r.forbiddenHits,
      flagCodes: r.complianceFlags.map((f) => f.code),
    }).toEqual(row.expected);
  });

  it("agregado idêntico ao do Python para as 6 respostas finais por caso", () => {
    // Python: svc.evaluate({case_id: resposta}); a última resposta de cada id vale.
    const answers: Record<string, string> = {};
    for (const p of PARITY) answers[p.caseId] = p.answer;
    const report = evaluate(answers);
    expect(report.answered).toBe(6);
    expect(report.passed).toBe(3);
    expect(report.passRate).toBe(0.5);
    expect(report.avgScore).toBe(0.75);
    expect(report.complianceViolations).toBe(2);
    expect(report.byCategory).toEqual({
      tributacao: { answered: 3, passed: 1, avgScore: 0.8333 },
      macro: { answered: 2, passed: 1, avgScore: 0.5 },
      produtos: { answered: 1, passed: 1, avgScore: 1 },
    });
  });
});
