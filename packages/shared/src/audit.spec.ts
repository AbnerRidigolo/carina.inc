import { describe, expect, it } from "vitest";
import { AuditEventViewSchema, ComplianceFlagSchema } from "./audit.js";

describe("audit", () => {
  it("ComplianceFlag", () => {
    const f = { code: "c", severity: "warning", detail: "d" };
    expect(ComplianceFlagSchema.safeParse(f).success).toBe(true);
    expect(ComplianceFlagSchema.safeParse({ ...f, severity: "fatal" }).success).toBe(false);
  });

  it("AuditEventView", () => {
    const e = {
      id: "a1",
      channel: "chat",
      query: "q",
      agents: ["insight"],
      flags: [{ code: "c", severity: "info", detail: "d" }],
      durationMs: 120,
      createdAt: "2026-11-11T10:00:00.000Z",
    };
    expect(AuditEventViewSchema.safeParse(e).success).toBe(true);
    expect(AuditEventViewSchema.safeParse({ ...e, clientId: "c1" }).success).toBe(true);
    expect(AuditEventViewSchema.safeParse({ ...e, createdAt: "ontem" }).success).toBe(false);
    expect(AuditEventViewSchema.safeParse({ ...e, durationMs: -1 }).success).toBe(false);
  });
});
