import { describe, expect, it } from "vitest";
import {
  AopAgentSchema,
  AopCreateSchema,
  AopRunPageSchema,
  AopRunSchema,
  AopSchema,
  AopUpdateSchema,
  ScheduleSchema,
} from "./aops.js";

const UUID = "3f1c2a64-8d0e-4b8e-9a53-0f7c1b2d4e61";
const aop = {
  id: UUID,
  name: "Revisão semanal",
  description: "Toda sexta, analise a carteira.",
  agents: ["insight", "risk"],
  schedule: { frequency: "weekly", weekday: 4, day: 1, hour: 9 },
  clientIds: ["cliente-1"],
  enabled: true,
  createdAt: "2026-11-25T12:00:00.000Z",
  lastFireAt: null,
};

describe("contratos de AOP", () => {
  it("AopAgent aceita os 7 especialistas e recusa executor, navigator e nomes do Python", () => {
    for (const a of [
      "insight",
      "predictor",
      "risk",
      "strategist",
      "tax",
      "researcher",
      "assessor_liaison",
    ]) {
      expect(AopAgentSchema.safeParse(a).success).toBe(true);
    }
    for (const a of ["executor", "navigator", "monitor", "tax_optimizer"]) {
      expect(AopAgentSchema.safeParse(a).success).toBe(false);
    }
  });

  it("Schedule aplica o padrão semanal, sexta, 9h e recusa valores fora da faixa", () => {
    expect(ScheduleSchema.parse({})).toEqual({ frequency: "weekly", weekday: 4, day: 1, hour: 9 });
    expect(ScheduleSchema.safeParse({ day: 29 }).success).toBe(false);
    expect(ScheduleSchema.safeParse({ day: 0 }).success).toBe(false);
    expect(ScheduleSchema.safeParse({ weekday: 7 }).success).toBe(false);
    expect(ScheduleSchema.safeParse({ hour: 24 }).success).toBe(false);
    expect(ScheduleSchema.safeParse({ hour: 1.5 }).success).toBe(false);
    expect(ScheduleSchema.safeParse({ frequency: "yearly" }).success).toBe(false);
  });

  it("Aop aceita um AOP válido e recusa agentes vazios, mais de 3 agentes e clientes demais", () => {
    expect(AopSchema.safeParse(aop).success).toBe(true);
    expect(AopSchema.safeParse({ ...aop, agents: [] }).success).toBe(false);
    expect(
      AopSchema.safeParse({ ...aop, agents: ["insight", "risk", "tax", "predictor"] }).success,
    ).toBe(false);
    expect(AopSchema.safeParse({ ...aop, clientIds: [] }).success).toBe(false);
    expect(
      AopSchema.safeParse({
        ...aop,
        clientIds: Array.from({ length: 21 }, (_, i) => `c${i}`),
      }).success,
    ).toBe(false);
    expect(AopSchema.safeParse({ ...aop, name: "" }).success).toBe(false);
    expect(AopSchema.safeParse({ ...aop, name: "x".repeat(121) }).success).toBe(false);
    expect(AopSchema.safeParse({ ...aop, description: "x".repeat(2001) }).success).toBe(false);
    expect(AopSchema.safeParse({ ...aop, lastFireAt: "2026-11-21T12:00:00.000Z" }).success).toBe(
      true,
    );
  });

  it("AopCreate exige descrição e clientes; name é opcional; recusa campos extras", () => {
    expect(AopCreateSchema.safeParse({ description: "analise", clientIds: ["a"] }).success).toBe(
      true,
    );
    expect(
      AopCreateSchema.safeParse({ description: "analise", clientIds: ["a"], name: "Meu" }).success,
    ).toBe(true);
    expect(AopCreateSchema.safeParse({ description: "", clientIds: ["a"] }).success).toBe(false);
    expect(AopCreateSchema.safeParse({ description: "x", clientIds: [] }).success).toBe(false);
    expect(
      AopCreateSchema.safeParse({ description: "x", clientIds: ["a"], agents: ["executor"] })
        .success,
    ).toBe(false);
  });

  it("AopUpdate exige enabled booleano e recusa campos extras", () => {
    expect(AopUpdateSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(AopUpdateSchema.safeParse({}).success).toBe(false);
    expect(AopUpdateSchema.safeParse({ enabled: "sim" }).success).toBe(false);
    expect(AopUpdateSchema.safeParse({ enabled: true, name: "x" }).success).toBe(false);
  });

  const run = {
    id: UUID,
    aopId: UUID,
    clientId: "cliente-1",
    fireAt: "2026-11-21T12:00:00.000Z",
    trigger: "schedule",
    status: "ok",
    failureCode: null,
    results: { insight: { resumo: "ok" }, risk: { failed: true } },
    workType: "multi_agent_analysis",
    priceBrl: "0.80",
    createdAt: "2026-11-21T12:00:05.000Z",
  };

  it("AopRun aceita execução ok e pulada, recusa status e código desconhecidos", () => {
    expect(AopRunSchema.safeParse(run).success).toBe(true);
    expect(
      AopRunSchema.safeParse({
        ...run,
        status: "skipped",
        failureCode: "quota_exceeded",
        results: {},
        workType: null,
        priceBrl: null,
      }).success,
    ).toBe(true);
    expect(AopRunSchema.safeParse({ ...run, status: "done" }).success).toBe(false);
    expect(AopRunSchema.safeParse({ ...run, failureCode: "boom" }).success).toBe(false);
    expect(AopRunSchema.safeParse({ ...run, trigger: "cron" }).success).toBe(false);
    expect(AopRunSchema.safeParse({ ...run, priceBrl: 0.8 }).success).toBe(false);
  });

  it("AopRunPage aceita cursor nulo ou texto e exige o campo", () => {
    expect(AopRunPageSchema.safeParse({ items: [run], nextCursor: null }).success).toBe(true);
    expect(AopRunPageSchema.safeParse({ items: [], nextCursor: "abc" }).success).toBe(true);
    expect(AopRunPageSchema.safeParse({ items: [run] }).success).toBe(false);
  });
});
