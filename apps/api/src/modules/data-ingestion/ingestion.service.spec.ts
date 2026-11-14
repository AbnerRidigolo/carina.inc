import { describe, expect, it } from "vitest";
import { TransactionsQuerySchema } from "./ingestion.controller.js";
import { dedupeByExternalId } from "./ingestion.service.js";

describe("dedupeByExternalId", () => {
  it("o último item de cada externalId vence", () => {
    const out = dedupeByExternalId([
      { externalId: "a", v: 1 },
      { externalId: "b", v: 2 },
      { externalId: "a", v: 3 },
    ]);
    expect(out).toEqual([
      { externalId: "a", v: 3 },
      { externalId: "b", v: 2 },
    ]);
  });

  it("ordena por externalId (ordem de bloqueio estável entre lotes concorrentes)", () => {
    const ids = (xs: string[]) =>
      dedupeByExternalId(xs.map((externalId) => ({ externalId }))).map((x) => x.externalId);
    expect(ids(["c", "a", "B", "b"])).toEqual(["B", "a", "b", "c"]);
    expect(ids(["b", "B", "a", "c"])).toEqual(ids(["c", "a", "B", "b"]));
  });

  it("não perde itens quando não há repetição", () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ externalId: `p${i}` }));
    expect(dedupeByExternalId(items)).toHaveLength(1000);
  });
});

describe("TransactionsQuerySchema", () => {
  it("padrão: limit 100, sem filtros", () => {
    expect(TransactionsQuerySchema.parse({})).toEqual({ limit: 100 });
  });

  it("converte limit e aceita datas", () => {
    expect(
      TransactionsQuerySchema.parse({ limit: "250", from: "2026-01-01", to: "2026-01-31" }),
    ).toEqual({ limit: 250, from: "2026-01-01", to: "2026-01-31" });
  });

  it.each([
    { limit: "0" },
    { limit: "1001" },
    { limit: "-1" },
    { limit: "1.5" },
    { limit: "" },
    { limit: ["1", "2"] },
    { from: "2026-02-30" },
    { to: "ontem" },
    { from: "2026-02-02", to: "2026-02-01" },
  ])("rejeita %j", (q) => {
    expect(TransactionsQuerySchema.safeParse(q).success).toBe(false);
  });
});
