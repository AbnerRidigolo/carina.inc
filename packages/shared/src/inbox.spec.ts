import { describe, expect, it } from "vitest";
import { ApprovalViewSchema, DecisionRequestSchema, RiskClassSchema } from "./inbox.js";

const approval = {
  id: "ap1",
  clientId: "c1",
  agent: "executor",
  action: "buy",
  risk: "irreversible",
  payload: { code: "X" },
  valueBrl: "100.00",
  status: "pending",
  expiresAt: "2026-11-12T10:00:00.000Z",
  createdAt: "2026-11-11T10:00:00.000Z",
};

describe("inbox", () => {
  it("RiskClass", () => {
    for (const r of ["read", "reversible", "irreversible"]) {
      expect(RiskClassSchema.safeParse(r).success).toBe(true);
    }
    expect(RiskClassSchema.safeParse("high").success).toBe(false);
  });

  it("ApprovalView", () => {
    expect(ApprovalViewSchema.safeParse(approval).success).toBe(true);
    expect(ApprovalViewSchema.safeParse({ ...approval, status: "done" }).success).toBe(false);
    expect(ApprovalViewSchema.safeParse({ ...approval, valueBrl: 100 }).success).toBe(false);
    expect(ApprovalViewSchema.safeParse({ ...approval, expiresAt: "amanhã" }).success).toBe(false);
  });

  it("DecisionRequest", () => {
    const reason = (n: number) => ({ approved: false, reason: "x".repeat(n) });
    expect(DecisionRequestSchema.safeParse({ approved: true }).success).toBe(true);
    expect(DecisionRequestSchema.safeParse(reason(500)).success).toBe(true);
    expect(DecisionRequestSchema.safeParse(reason(501)).success).toBe(false);
    expect(DecisionRequestSchema.safeParse({ approved: "yes" }).success).toBe(false);
  });
});
