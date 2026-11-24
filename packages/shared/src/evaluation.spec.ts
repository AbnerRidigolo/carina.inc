import { describe, expect, it } from "vitest";
import {
  EvalCaseResultSchema,
  EvalCaseViewSchema,
  EvalCategorySchema,
  EvalReportSchema,
  EvalSubmitSchema,
} from "./evaluation.js";

describe("EvalCategorySchema", () => {
  it("aceita as cinco categorias do benchmark", () => {
    for (const c of ["tributacao", "cvm", "open_finance", "produtos", "macro"]) {
      expect(EvalCategorySchema.safeParse(c).success).toBe(true);
    }
  });
  it("recusa categoria desconhecida", () => {
    expect(EvalCategorySchema.safeParse("xyz").success).toBe(false);
  });
});

describe("EvalCaseViewSchema", () => {
  it("expõe só id, categoria, dificuldade e pergunta (descarta gabarito)", () => {
    const parsed = EvalCaseViewSchema.parse({
      id: "ptax",
      category: "macro",
      difficulty: "easy",
      question: "O que é a PTAX?",
      expectedFacts: [{ description: "x", alternatives: ["y"] }],
      reference: "Circular",
    });
    expect(Object.keys(parsed).sort()).toEqual(["category", "difficulty", "id", "question"]);
  });
});

describe("EvalSubmitSchema", () => {
  it("aceita de 1 a 42 respostas", () => {
    expect(EvalSubmitSchema.safeParse({ answers: { a: "texto" } }).success).toBe(true);
    const many = Object.fromEntries(Array.from({ length: 42 }, (_, i) => [`c${i}`, "r"]));
    expect(EvalSubmitSchema.safeParse({ answers: many }).success).toBe(true);
  });
  it("recusa zero respostas e mais de 42", () => {
    expect(EvalSubmitSchema.safeParse({ answers: {} }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 43 }, (_, i) => [`c${i}`, "r"]));
    expect(EvalSubmitSchema.safeParse({ answers: many }).success).toBe(false);
  });
  it("ids só com [a-z0-9-], de 1 a 64 caracteres", () => {
    expect(EvalSubmitSchema.safeParse({ answers: { "acoes-isencao-20k": "r" } }).success).toBe(
      true,
    );
    expect(EvalSubmitSchema.safeParse({ answers: { ["a".repeat(64)]: "r" } }).success).toBe(true);
    for (const bad of ["a".repeat(65), "A", "a b", "a_b", "", "ação", "a/b"]) {
      expect(EvalSubmitSchema.safeParse({ answers: { [bad]: "r" } }).success, bad).toBe(false);
    }
  });
  it("recusa a chave __proto__ (antes era descartada em silêncio)", () => {
    const body: unknown = JSON.parse('{"answers":{"__proto__":"x","ptax":"y"}}');
    expect(EvalSubmitSchema.safeParse(body).success).toBe(false);
  });
  it("limita o texto a 20 000 caracteres", () => {
    expect(EvalSubmitSchema.safeParse({ answers: { a: "x".repeat(20_000) } }).success).toBe(true);
    expect(EvalSubmitSchema.safeParse({ answers: { a: "x".repeat(20_001) } }).success).toBe(false);
  });
});

describe("EvalReportSchema", () => {
  const result = {
    caseId: "ptax",
    category: "macro",
    score: 0.5,
    passed: false,
    factsTotal: 2,
    factsMatched: 1,
    forbiddenHits: 0,
    complianceFlags: [],
  };
  it("valida o resultado de um caso", () => {
    expect(EvalCaseResultSchema.safeParse(result).success).toBe(true);
    expect(EvalCaseResultSchema.safeParse({ ...result, score: 1.5 }).success).toBe(false);
  });
  it("o resultado de um caso só traz contagens, nunca o texto do gabarito", () => {
    const parsed = EvalCaseResultSchema.parse({ ...result, matched: ["a"], missing: ["b"] });
    expect(Object.keys(parsed).sort()).toEqual([
      "caseId",
      "category",
      "complianceFlags",
      "factsMatched",
      "factsTotal",
      "forbiddenHits",
      "passed",
      "score",
    ]);
    expect(EvalCaseResultSchema.safeParse({ ...result, forbiddenHits: ["x"] }).success).toBe(false);
    expect(EvalCaseResultSchema.safeParse({ ...result, factsTotal: 0.5 }).success).toBe(false);
    expect(EvalCaseResultSchema.safeParse({ ...result, factsMatched: 3 }).success).toBe(false);
  });
  it("valida o relatório com o uso cobrado", () => {
    const report = {
      answered: 1,
      passed: 0,
      passRate: 0,
      avgScore: 0.5,
      complianceViolations: 0,
      byCategory: { macro: { answered: 1, passed: 0, avgScore: 0.5 } },
      results: [result],
      usage: { workType: "evaluation", priceBrl: "5.00" },
    };
    expect(EvalReportSchema.safeParse(report).success).toBe(true);
    expect(EvalReportSchema.safeParse({ ...report, usage: undefined }).success).toBe(false);
  });
});
