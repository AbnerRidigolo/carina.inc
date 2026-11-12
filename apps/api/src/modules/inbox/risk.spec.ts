import { describe, expect, it } from "vitest";
import { classifyRisk, READ_ACTIONS, REVERSIBLE_ACTIONS } from "./risk.js";

describe("classifyRisk", () => {
  it("place_trade e pix_out são irreversíveis", () => {
    expect(classifyRisk("place_trade")).toBe("irreversible");
    expect(classifyRisk("pix_out")).toBe("irreversible");
  });

  it("ações de leitura são read", () => {
    expect(classifyRisk("get_positions")).toBe("read");
    for (const a of READ_ACTIONS) expect(classifyRisk(a)).toBe("read");
  });

  it("ações reversíveis explícitas são reversible", () => {
    for (const a of REVERSIBLE_ACTIONS) expect(classifyRisk(a)).toBe("reversible");
    expect([...REVERSIBLE_ACTIONS].sort()).toEqual([
      "create_alert",
      "schedule_report",
      "update_goal",
    ]);
  });

  it("ação desconhecida, vazia ou com outra caixa é irreversível (falha fechada)", () => {
    for (const a of [
      "",
      "unknown",
      "GET_POSITIONS",
      " get_positions",
      "__proto__",
      "constructor",
    ]) {
      expect(classifyRisk(a), a).toBe("irreversible");
    }
  });
});
