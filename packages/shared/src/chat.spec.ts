import { describe, expect, it } from "vitest";
import { ChatEventSchema, ChatRequestSchema } from "./chat.js";

const approval = {
  id: "ap1",
  clientId: "c1",
  agent: "executor",
  action: "buy",
  risk: "irreversible",
  payload: {},
  valueBrl: "100.00",
  status: "pending",
  expiresAt: "2026-11-12T10:00:00.000Z",
  createdAt: "2026-11-11T10:00:00.000Z",
};

describe("ChatRequestSchema", () => {
  it("aceita válido e faz trim", () => {
    const r = ChatRequestSchema.parse({ clientId: "c1", message: "  oi  " });
    expect(r.message).toBe("oi");
  });
  it("rejeita mensagem só com espaços", () => {
    expect(ChatRequestSchema.safeParse({ clientId: "c1", message: "   " }).success).toBe(false);
  });
  it("limite de 8000 caracteres", () => {
    const msg = (n: number) => ({ clientId: "c1", message: "a".repeat(n) });
    expect(ChatRequestSchema.safeParse(msg(8000)).success).toBe(true);
    expect(ChatRequestSchema.safeParse(msg(8001)).success).toBe(false);
  });
  it("rejeita clientId inválido", () => {
    for (const clientId of ["a__b/../x", "", "a".repeat(65), "a b"]) {
      expect(ChatRequestSchema.safeParse({ clientId, message: "oi" }).success).toBe(false);
    }
    expect(ChatRequestSchema.safeParse({ clientId: "a__b-1", message: "oi" }).success).toBe(true);
  });
  it("threadId opcional", () => {
    const r = { clientId: "c1", message: "oi", threadId: "t1" };
    expect(ChatRequestSchema.safeParse(r).success).toBe(true);
  });
});

describe("ChatEventSchema", () => {
  const plan = { complexity: "simples", agents: [], wantsExecution: false, rationale: "r" };
  const done = {
    type: "done",
    threadId: "t",
    status: "completed",
    answer: "a",
    usage: { workType: "query", priceBrl: "1.50" },
    compliance: { auditId: "a1", flags: [] },
  };

  it("error", () => {
    const e = ChatEventSchema.parse({ type: "error", code: "llm_unavailable", traceId: "t" });
    expect(e.type).toBe("error");
  });

  it("aceita cada variante", () => {
    const events = [
      { type: "plan", plan },
      { type: "agent_started", agent: "insight" },
      { type: "token", agent: "navigator", text: "x" },
      { type: "agent_result", agent: "risk", result: { a: 1 } },
      { type: "approval_required", approval },
      { type: "approval_executed", approvalId: "ap1", status: "succeeded" },
      { type: "approval_executed", approvalId: "ap1", status: "failed", result: null },
      done,
      { ...done, status: "awaiting_approval" },
    ];
    for (const e of events) expect(ChatEventSchema.safeParse(e).success).toBe(true);
  });

  it("rejeita tipo desconhecido e campos inválidos", () => {
    const badUsage = { ...done, usage: { workType: "query", priceBrl: 1.5 } };
    expect(ChatEventSchema.safeParse({ type: "nope" }).success).toBe(false);
    expect(ChatEventSchema.safeParse({ ...done, status: "x" }).success).toBe(false);
    expect(ChatEventSchema.safeParse(badUsage).success).toBe(false);
    expect(ChatEventSchema.safeParse({ type: "token", agent: "zzz", text: "x" }).success).toBe(
      false,
    );
  });
});
