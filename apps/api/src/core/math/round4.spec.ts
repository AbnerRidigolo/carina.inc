import { describe, expect, it } from "vitest";
import { round4 } from "./round4.js";

describe("round4", () => {
  it("imita o round(x, 4) do Python, inclusive empates exatos (para o par)", () => {
    expect(round4(0.03125)).toBe(0.0312);
    expect(round4(0.09375)).toBe(0.0938);
    expect(round4(0.00005)).toBe(0.0001);
    expect(round4(2 / 3)).toBe(0.6667);
    expect(round4(1)).toBe(1);
    expect(round4(0)).toBe(0);
    expect(round4(-33.96226415)).toBe(-33.9623);
  });
});
