/**
 * Iteradores por id interno do IngestionService (consumidos pelo worker de Sync): paginação por
 * keyset sem teto total, sob o TenantContext do chamador (RLS) e com o cliente fixado por dentro.
 */
import {
  NormalizedPositionSchema,
  NormalizedTransactionSchema,
  type NormalizedPosition,
  type NormalizedTransaction,
} from "@carina/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import { UnauthenticatedError, ValidationError } from "../../src/core/errors/domain-errors.js";
import { DataIngestionModule } from "../../src/modules/data-ingestion/data-ingestion.module.js";
import { IngestionService } from "../../src/modules/data-ingestion/ingestion.service.js";
import { createTestApp, type SeededTenant, type TestApp } from "../setup/app.js";
import { migratorSql } from "../setup/db.js";

const N = 2500;
const SYNTHETIC_DUPLICATES = 100;
const pad = (i: number) => String(i).padStart(5, "0");
const dayOf = (i: number) => new Date(Date.UTC(2026, 0, 1 + (i % 90))).toISOString().slice(0, 10);

async function collect<T>(it: AsyncIterable<T[]>): Promise<T[][]> {
  const pages: T[][] = [];
  for await (const page of it) pages.push(page);
  return pages;
}

describe("IngestionService: iteradores por id interno (Sync)", () => {
  let t: TestApp;
  let svc: IngestionService;
  let A: SeededTenant;
  let B: SeededTenant;
  let aClient: string;
  let bClient: string;

  const insertClient = async (tenantId: string, externalId: string) => {
    const [row] = await migratorSql<{ id: string }>(
      `INSERT INTO client (tenant_id, external_id) VALUES ($1, $2) RETURNING id`,
      [tenantId, externalId],
      { tenantId },
    );
    if (!row) throw new Error("INSERT INTO client não devolveu id");
    return row.id;
  };

  const seedPositions = (tenantId: string, clientId: string, n: number) =>
    migratorSql(
      `INSERT INTO position (tenant_id, client_id, source, external_id, institution, kind,
         asset_class, name, value_brl, as_of)
       SELECT $1, $2, 'api', 'p' || lpad(i::text, 5, '0'), 'XP', 'investment', 'acao',
              'Ativo ' || i, 1.50, date '2026-11-10'
       FROM generate_series(0, $3::int - 1) AS i`,
      [tenantId, clientId, n],
      { tenantId },
    );

  const seedTransactions = (tenantId: string, clientId: string, n: number) =>
    migratorSql(
      `INSERT INTO "transaction" (tenant_id, client_id, source, external_id, institution, account,
         date, description, amount_brl, kind)
       SELECT $1, $2, 'api', 't' || lpad(i::text, 5, '0'), 'Itaú', 'cc-1',
              date '2026-01-01' + (i % 90), 'Lançamento ' || i, -1.25, 'debit'
       FROM generate_series(0, $3::int - 1) AS i`,
      [tenantId, clientId, n],
      { tenantId },
    );

  const asTenant = <R>(tenantId: string, fn: () => Promise<R>) =>
    TenantContext.run({ tenantId }, fn);

  beforeAll(async () => {
    t = await createTestApp({ imports: [DataIngestionModule], redisDb: 9 });
    svc = t.app.get(IngestionService);
    A = await t.seedTenant({ name: "A" });
    B = await t.seedTenant({ name: "B" });
    aClient = await insertClient(A.tenantId, "c1");
    bClient = await insertClient(B.tenantId, "c1");
    await seedPositions(A.tenantId, aClient, N);
    // Mesmos externalId em outra fonte: a paginação não pode perder nem repetir nenhuma.
    await migratorSql(
      `INSERT INTO position (tenant_id, client_id, source, external_id, institution, kind,
         asset_class, name, value_brl, as_of)
       SELECT $1, $2, 'synthetic', external_id, 'XP', 'investment', 'acao', 'sintético', 1,
              date '2026-11-10'
       FROM position WHERE source = 'api' AND external_id < 'p' || lpad($3::text, 5, '0')`,
      [A.tenantId, aClient, SYNTHETIC_DUPLICATES],
      { tenantId: A.tenantId },
    );
    await seedTransactions(A.tenantId, aClient, N);
    await seedPositions(B.tenantId, bClient, 30);
    await seedTransactions(B.tenantId, bClient, 30);
  }, 60_000);

  afterAll(async () => {
    await t?.close();
  });

  describe("iteratePositions", () => {
    it("percorre 2.600 linhas (2.500 + 100 de outra fonte) em páginas de 1.000, sem duplicar nem perder", async () => {
      const pages = await asTenant(A.tenantId, () => collect(svc.iteratePositions(aClient)));
      expect(pages.map((p) => p.length)).toEqual([1000, 1000, 600]);
      const flat = pages.flat();
      for (const p of flat) NormalizedPositionSchema.strict().parse(p);
      const expected = Array.from({ length: N }, (_, i) => `p${pad(i)}`).flatMap((id, i) =>
        i < SYNTHETIC_DUPLICATES ? [id, id] : [id],
      );
      expect(flat.map((p) => p.externalId)).toEqual(expected);
      // As linhas repetidas são mesmo as duas fontes (api e sintético), cada uma uma vez.
      const first = flat.filter((p) => p.externalId === "p00000");
      expect(first.map((p) => p.name).sort()).toEqual(["Ativo 0", "sintético"]);
    });

    it("pageSize menor: mesmas linhas, na mesma ordem", async () => {
      const pages = await asTenant(A.tenantId, () =>
        collect(svc.iteratePositions(aClient, { pageSize: 333 })),
      );
      expect(pages.every((p) => p.length <= 333)).toBe(true);
      expect(pages.map((p) => p.length).reduce((a, b) => a + b, 0)).toBe(N + SYNTHETIC_DUPLICATES);
      const ids = pages.flat().map((p) => p.externalId);
      expect(ids).toEqual([...ids].sort());
    });

    it("cliente sem linhas: nenhuma página", async () => {
      const empty = await insertClient(A.tenantId, "vazio");
      expect(await asTenant(A.tenantId, () => collect(svc.iteratePositions(empty)))).toEqual([]);
    });
  });

  describe("iterateTransactions", () => {
    const expectedIds = (from?: string, to?: string) =>
      Array.from({ length: N }, (_, i) => ({ id: `t${pad(i)}`, date: dayOf(i) }))
        .filter((x) => (from === undefined || x.date >= from) && (to === undefined || x.date <= to))
        .sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? 1 : -1))
        .map((x) => x.id);

    it("percorre as 2.500 transações em páginas de 1.000: mais recentes primeiro, sem duplicar nem perder", async () => {
      const pages = await asTenant(A.tenantId, () => collect(svc.iterateTransactions(aClient)));
      expect(pages.map((p) => p.length)).toEqual([1000, 1000, 500]);
      const flat: NormalizedTransaction[] = pages.flat();
      for (const x of flat) NormalizedTransactionSchema.strict().parse(x);
      expect(flat.map((x) => x.externalId)).toEqual(expectedIds());
    });

    it("from/to (inclusivos) e pageSize pequeno atravessam datas repetidas sem pular linhas", async () => {
      const from = "2026-02-01";
      const to = "2026-03-15";
      const pages = await asTenant(A.tenantId, () =>
        collect(svc.iterateTransactions(aClient, { pageSize: 97, from, to })),
      );
      expect(pages.every((p) => p.length <= 97)).toBe(true);
      expect(pages.flat().map((x) => x.externalId)).toEqual(expectedIds(from, to));
    });

    it("from/to inválidos ou invertidos → ValidationError", () => {
      expect(() => svc.iterateTransactions(aClient, { from: "2026-02-30" })).toThrow(
        ValidationError,
      );
      expect(() =>
        svc.iterateTransactions(aClient, { from: "2026-03-01", to: "2026-02-01" }),
      ).toThrow(ValidationError);
    });
  });

  describe("isolamento e validação", () => {
    it("o cliente de A sob o contexto de B não devolve nada (os dados existem nos dois tenants)", async () => {
      expect(await asTenant(B.tenantId, () => collect(svc.iteratePositions(aClient)))).toEqual([]);
      expect(await asTenant(B.tenantId, () => collect(svc.iterateTransactions(aClient)))).toEqual(
        [],
      );
      // E o inverso: A não enxerga o cliente de B.
      expect(await asTenant(A.tenantId, () => collect(svc.iteratePositions(bClient)))).toEqual([]);
      expect(await asTenant(A.tenantId, () => collect(svc.iterateTransactions(bClient)))).toEqual(
        [],
      );
      // Cada tenant segue vendo só o seu.
      const b = await asTenant(B.tenantId, () => collect(svc.iteratePositions(bClient)));
      expect(b.flat()).toHaveLength(30);
      const bt = await asTenant(B.tenantId, () => collect(svc.iterateTransactions(bClient)));
      expect(bt.flat()).toHaveLength(30);
    });

    it("um uuid inexistente também não devolve nada", async () => {
      const ghost = "00000000-0000-4000-8000-000000000000";
      expect(await asTenant(A.tenantId, () => collect(svc.iteratePositions(ghost)))).toEqual([]);
    });

    it("clientId que não é uuid → ValidationError (síncrono, antes de qualquer consulta)", () => {
      for (const id of ["c1", "", "not-a-uuid", `${aClient}x`, "' OR 1=1 --"]) {
        expect(() => svc.iteratePositions(id), id).toThrow(ValidationError);
        expect(() => svc.iterateTransactions(id), id).toThrow(ValidationError);
      }
    });

    it("pageSize fora de 1..1000 → ValidationError", () => {
      for (const pageSize of [0, -1, 1001, 1.5, Number.NaN]) {
        expect(() => svc.iteratePositions(aClient, { pageSize })).toThrow(ValidationError);
        expect(() => svc.iterateTransactions(aClient, { pageSize })).toThrow(ValidationError);
      }
    });

    it("sem TenantContext: UnauthenticatedError (falha fechada)", async () => {
      await expect(collect(svc.iteratePositions(aClient))).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
    });

    it("os métodos por externalId (HTTP) continuam exigindo o externalId e não aceitam o uuid", async () => {
      await asTenant(A.tenantId, async () => {
        await expect(svc.listPositions(aClient)).rejects.toMatchObject({ status: 404 });
        const page = await svc.listPositions("c1", { limit: 5 });
        expect((page.positions satisfies NormalizedPosition[]).length).toBe(5);
        expect(page.nextCursor).toEqual(expect.any(String));
      });
    });
  });
});
