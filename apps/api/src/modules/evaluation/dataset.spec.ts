import { describe, expect, it } from "vitest";
import { EVAL_CATEGORIES } from "@carina/shared";
import { EVAL_DATASET } from "./dataset.js";

describe("dataset do SEAL BR", () => {
  it("tem ids únicos e 42 casos", () => {
    const ids = EVAL_DATASET.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(EVAL_DATASET).toHaveLength(42);
  });

  it("cobre todas as categorias", () => {
    expect(new Set(EVAL_DATASET.map((c) => c.category))).toEqual(new Set(EVAL_CATEGORIES));
  });

  it("todo caso tem gabarito, alternativas e referência", () => {
    for (const c of EVAL_DATASET) {
      expect(c.expectedFacts.length, c.id).toBeGreaterThan(0);
      expect(
        c.expectedFacts.every((f) => f.alternatives.length > 0),
        c.id,
      ).toBe(true);
      expect(c.reference, c.id).not.toBe("");
    }
  });

  it("preserva casos conhecidos do Python (id, dificuldade e contagem de fatos)", () => {
    const swing = EVAL_DATASET.find((c) => c.id === "acoes-aliquota-swing");
    expect(swing?.difficulty).toBe("easy");
    expect(swing?.expectedFacts).toHaveLength(1);
    expect(swing?.forbidden[0]?.alternatives).toEqual(["27.5%", "27.5 %"]);
    expect(EVAL_DATASET.find((c) => c.id === "fgc-cobertura")?.expectedFacts).toHaveLength(3);
  });
});
