import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import { PrismaService } from "../../src/core/database/prisma.service.js";
import { TenantPrismaService } from "../../src/core/database/tenant-prisma.service.js";
import {
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "../../src/core/errors/domain-errors.js";
import { ClientsService } from "../../src/modules/tenancy/clients.service.js";
import { appUrl, migratorSql } from "../setup/db.js";

describe("ClientsService (carina_app, sob RLS)", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  let prisma: PrismaService;
  let clients: ClientsService;

  const inA = <T>(fn: () => Promise<T>) => TenantContext.run({ tenantId: tenantA }, fn);
  const inB = <T>(fn: () => Promise<T>) => TenantContext.run({ tenantId: tenantB }, fn);

  beforeAll(async () => {
    await migratorSql(
      `INSERT INTO tenant (id, name, plan) VALUES ($1, 'A', 'pro'), ($2, 'B', 'pro')`,
      [tenantA, tenantB],
    );
    await migratorSql(
      `INSERT INTO client (tenant_id, external_id) VALUES ($1, 'b-only')`,
      [tenantB],
      { tenantId: tenantB },
    );
    prisma = new PrismaService({ DATABASE_URL: appUrl() });
    clients = new ClientsService(new TenantPrismaService(prisma));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("resolve sem create lança NotFoundError para cliente inexistente", async () => {
    await expect(inA(() => clients.resolve("nao-existe"))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("resolve não enxerga cliente de outro tenant (RLS) e lança NotFoundError", async () => {
    await expect(inA(() => clients.resolve("b-only"))).rejects.toBeInstanceOf(NotFoundError);
    await expect(inB(() => clients.resolve("b-only"))).resolves.toMatchObject({
      externalId: "b-only",
    });
  });

  it("resolve com create é idempotente, inclusive em chamadas concorrentes", async () => {
    const results = await inA(() =>
      Promise.all(Array.from({ length: 8 }, () => clients.resolve("novo", { create: true }))),
    );
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
    const again = await inA(() => clients.resolve("novo"));
    expect(again).toEqual(results[0]);
    const rows = await migratorSql<{ n: string }>(
      `SELECT count(*) AS n FROM client WHERE external_id = 'novo'`,
      [],
      { tenantId: tenantA },
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("create com o mesmo externalId de outro tenant cria um cliente separado", async () => {
    const a = await inA(() => clients.resolve("b-only", { create: true }));
    const b = await inB(() => clients.resolve("b-only"));
    expect(a.id).not.toBe(b.id);
  });

  it("list devolve só os clientes do tenant do contexto", async () => {
    const listB = await inB(() => clients.list());
    expect(listB.map((c) => c.externalId)).toEqual(["b-only"]);
    for (const c of listB) expect(c.createdAt).toBeInstanceOf(Date);
  });

  it("externalId vazio, longo demais ou com caracteres de controle → ValidationError", async () => {
    for (const bad of ["", "x".repeat(129), "a\u0000b", "a\nb"]) {
      await expect(inA(() => clients.resolve(bad, { create: true }))).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });

  it("fora de um TenantContext → UnauthenticatedError", async () => {
    await expect(clients.list()).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(clients.resolve("x")).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});
