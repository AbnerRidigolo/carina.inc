import { describe, expect, it } from "vitest";
import { MoneySchema } from "./money.js";

describe("MoneySchema", () => {
  it.each(["1234.56", "0", "-10.5", "5.00", "9999999999999999.99"])("aceita %s", (v) => {
    expect(MoneySchema.safeParse(v).success).toBe(true);
  });

  it.each(["1.234", "", "abc", "1,5", ".5", "1.", "12345678901234567", " 1"])("rejeita %s", (v) => {
    expect(MoneySchema.safeParse(v).success).toBe(false);
  });

  it("rejeita number", () => {
    expect(MoneySchema.safeParse(10).success).toBe(false);
  });
});
