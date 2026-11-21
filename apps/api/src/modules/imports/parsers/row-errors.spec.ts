import { describe, expect, it } from "vitest";
import { ROW_ERROR_MESSAGES, RowErrors } from "./row-errors.js";

describe("RowErrors", () => {
  it("guarda 100 e conta todos", () => {
    const e = new RowErrors();
    for (let i = 0; i < 150; i++) e.add(i + 1, "invalid_date", "data");
    expect(e.list()).toHaveLength(100);
    expect(e.count()).toBe(150);
  });

  it("monta o erro com mensagem fixa e campo opcional", () => {
    const e = new RowErrors();
    e.add(3, "missing_field");
    e.add(4, "invalid_amount", "valor");
    expect(e.list()[0]).toEqual({
      row: 3,
      code: "missing_field",
      message: ROW_ERROR_MESSAGES.missing_field,
    });
    expect(e.list()[1]).toMatchObject({ row: 4, field: "valor", code: "invalid_amount" });
  });

  it("list devolve cópia", () => {
    const e = new RowErrors();
    e.add(1, "schema");
    e.list().pop();
    expect(e.list()).toHaveLength(1);
  });
});

describe("ROW_ERROR_MESSAGES", () => {
  it("não tem interpolação", () => {
    const entries = Object.entries(ROW_ERROR_MESSAGES);
    expect(entries).toHaveLength(10);
    for (const [, m] of entries) {
      expect(m.length).toBeGreaterThan(0);
      expect(m).not.toMatch(/[{}$]/);
    }
  });
});
