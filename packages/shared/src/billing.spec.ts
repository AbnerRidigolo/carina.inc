import { describe, expect, it } from "vitest";
import { UsageSummarySchema, WorkTypeSchema } from "./billing.js";

describe("billing", () => {
  it("WorkType tem os 9 tipos", () => {
    expect(WorkTypeSchema.options).toHaveLength(9);
    expect(WorkTypeSchema.safeParse("multi_agent_analysis").success).toBe(true);
    expect(WorkTypeSchema.safeParse("outro").success).toBe(false);
  });

  it("UsageSummary", () => {
    const query = { count: 2, totalBrl: "3.00" };
    const u = {
      month: "2026-11",
      resolutions: 3,
      totalBrl: "10.50",
      byWorkType: { query, analysis: { count: 1, totalBrl: "7.50" } },
    };
    expect(UsageSummarySchema.safeParse(u).success).toBe(true);
    expect(UsageSummarySchema.safeParse({ ...u, byWorkType: {} }).success).toBe(true);
    expect(UsageSummarySchema.safeParse({ ...u, month: "2026-13" }).success).toBe(false);
    expect(UsageSummarySchema.safeParse({ ...u, month: "2026-1" }).success).toBe(false);
    expect(UsageSummarySchema.safeParse({ ...u, byWorkType: { foo: query } }).success).toBe(false);
  });
});
