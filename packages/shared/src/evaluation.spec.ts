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
    matched: ["a"],
    missing: ["b"],
    forbiddenHits: [],
    complianceFlags: [],
  };
  it("valida o resultado de um caso", () => {
    expect(EvalCaseResultSchema.safeParse(result).success).toBe(true);
    expect(EvalCaseResultSchema.safeParse({ ...result, score: 1.5 }).success).toBe(false);
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
