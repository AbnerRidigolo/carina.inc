import { describe, expect, it } from "vitest";
import {
  ExternalIdSchema,
  NormalizedPositionSchema,
  NormalizedTransactionSchema,
  PositionBatchSchema,
  StreamEventSchema,
  TransactionBatchSchema,
} from "./ingestion.js";

const validPosition = {
  externalId: "p1",
  institution: "XP",
  kind: "investment",
  assetClass: "acao",
  assetCode: "PETR4",
  name: "Petrobras",
  quantity: "100.12345678",
  valueBrl: "3500.00",
  asOf: "2026-11-11",
};

const validTransaction = {
  externalId: "t1",
  institution: "XP",
  account: "123",
  date: "2026-11-10",
  description: "Compra",
  amountBrl: "-3500.00",
  kind: "buy",
};

const pos = (over: Record<string, unknown>) =>
  NormalizedPositionSchema.safeParse({ ...validPosition, ...over }).success;
const tx = (over: Record<string, unknown>) =>
  NormalizedTransactionSchema.safeParse({ ...validTransaction, ...over }).success;

describe("NormalizedPosition", () => {
  it("aceita válida e sem opcionais", () => {
    expect(pos({})).toBe(true);
    expect(pos({ assetCode: undefined, quantity: undefined })).toBe(true);
  });
  it("rejeita quantity com 9 casas, valueBrl number e data inválida", () => {
    expect(pos({ quantity: "1.123456789" })).toBe(false);
    expect(pos({ valueBrl: 10 })).toBe(false);
    expect(pos({ asOf: "2026-13-01" })).toBe(false);
    expect(pos({ asOf: "11/11/2026" })).toBe(false);
  });
  it("externalId 1–128 e enums", () => {
    expect(pos({ externalId: "" })).toBe(false);
    expect(pos({ externalId: "x".repeat(128) })).toBe(true);
    expect(pos({ externalId: "x".repeat(129) })).toBe(false);
    expect(pos({ assetClass: "cripto" })).toBe(false);
    expect(pos({ kind: "other" })).toBe(false);
  });
});

describe("NormalizedTransaction", () => {
  it("aceita válida e cobre todos os kinds", () => {
    expect(tx({})).toBe(true);
    for (const kind of ["debit", "credit", "buy", "sell", "dividend", "jcp", "fee", "tax"]) {
      expect(tx({ kind })).toBe(true);
    }
    expect(tx({ kind: "x" })).toBe(false);
  });
  it("rejeita amount com 3 casas e quantity inválida", () => {
    expect(tx({ amountBrl: "1.234" })).toBe(false);
    expect(tx({ quantity: "abc" })).toBe(false);
    expect(tx({ quantity: "2.5", category: "c", assetCode: "A" })).toBe(true);
  });
});

describe("batches", () => {
  it("PositionBatch: 1–1000 itens", () => {
    const batch = (n: number) => ({ items: Array(n).fill(validPosition) });
    expect(PositionBatchSchema.safeParse({ items: [] }).success).toBe(false);
    expect(PositionBatchSchema.safeParse(batch(1)).success).toBe(true);
    expect(PositionBatchSchema.safeParse(batch(1000)).success).toBe(true);
    expect(PositionBatchSchema.safeParse(batch(1001)).success).toBe(false);
  });
  it("TransactionBatch: 1–1000 itens", () => {
    const batch = (n: number) => ({ items: Array(n).fill(validTransaction) });
    expect(TransactionBatchSchema.safeParse({ items: [] }).success).toBe(false);
    expect(TransactionBatchSchema.safeParse(batch(1)).success).toBe(true);
    expect(TransactionBatchSchema.safeParse(batch(1001)).success).toBe(false);
  });
});

describe("StreamEvent", () => {
  const base = {
    eventId: "3f2b8c1e-5d4a-4b7e-9c1a-2e6f8a0b1c3d",
    tenantId: "ten1",
    clientId: "c1",
  };
  const ev = (e: Record<string, unknown>) => StreamEventSchema.safeParse({ ...base, ...e }).success;

  it("aceita cada variante", () => {
    expect(ev({ type: "approval.created", approvalId: "a" })).toBe(true);
    expect(ev({ type: "approval.executed", approvalId: "a", status: "succeeded" })).toBe(true);
    expect(ev({ type: "approval.executed", approvalId: "a", status: "failed" })).toBe(true);
    expect(ev({ type: "resume", approvalId: "a", threadId: "t", approved: true })).toBe(true);
    expect(ev({ type: "data.ingested", source: "api" })).toBe(true);
    expect(ev({ type: "notification", kind: "info", text: "x" })).toBe(true);
  });
  it("rejeita eventId não-uuid, status inválido e tipo desconhecido", () => {
    expect(ev({ eventId: "x", type: "data.ingested", source: "api" })).toBe(false);
    expect(ev({ type: "approval.executed", approvalId: "a", status: "ok" })).toBe(false);
    expect(ev({ type: "zzz" })).toBe(false);
  });
});

describe("ExternalIdSchema", () => {
  const ok = (v: string) => ExternalIdSchema.safeParse(v).success;

  it("aceita ASCII com ponto, hífen, dois-pontos, barra e espaço", () => {
    for (const id of ["p1", "a.b-c_d", "acc:123/456", "com espaço", "X".repeat(128)]) {
      expect(ok(id), id).toBe(true);
    }
  });

  it("aceita letras acentuadas, outros alfabetos e emoji sem ZWJ", () => {
    for (const id of ["ação-é", "Çãõ", "日本語", "😀", "👍🏽", "❤\uFE0F", "🇧🇷"]) {
      expect(ok(id), id).toBe(true);
    }
  });

  it("conta caracteres (pontos de código): 128 emoji passam, 129 não", () => {
    expect(ok("😀".repeat(128))).toBe(true);
    expect(ok("😀".repeat(129))).toBe(false);
  });

  it.each([
    ["vazio", ""],
    ["129 caracteres", "x".repeat(129)],
    ["NUL", "a\u0000b"],
    ["TAB", "a\tb"],
    ["quebra de linha", "a\nb"],
    ["retorno de carro", "a\rb"],
    ["DEL", "a\u007fb"],
    ["controle C1", "a\u0085b"],
    ["ZWJ (emoji de família)", "👨\u200d👩\u200d👧"],
    ["zero-width space", "a\u200bb"],
    ["hífen suave", "a\u00adb"],
    ["BOM", "\ufeffa"],
    ["marca bidi (RLM)", "a\u200fb"],
    ["override bidi (RLO)", "a\u202eb"],
    ["uso privado", "a\ue000b"],
    ["não atribuído", "a\u0378b"],
    ["surrogate solto (alto)", "a\ud800b"],
    ["surrogate solto (baixo)", "\udc00"],
  ])("rejeita %s", (_name, id) => {
    expect(ok(id)).toBe(false);
  });

  it("vale para posições e transações, e o caminho do erro cita items.N.externalId", () => {
    expect(pos({ externalId: "a\tb" })).toBe(false);
    expect(tx({ externalId: "a\u200db" })).toBe(false);
    const r = PositionBatchSchema.safeParse({
      items: [validPosition, { ...validPosition, externalId: "a\nb" }],
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path.join(".")).toBe("items.1.externalId");
  });
});
