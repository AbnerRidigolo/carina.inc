import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import { PrismaService } from "../../src/core/database/prisma.service.js";
import { TenantPrismaService } from "../../src/core/database/tenant-prisma.service.js";
import { UnauthenticatedError, ValidationError } from "../../src/core/errors/domain-errors.js";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { appUrl, migratorSql } from "../setup/db.js";

describe("TenantPrismaService: isolamento por RLS (conectado como carina_app)", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const clientA1 = randomUUID();
  const clientA2 = randomUUID();
  const clientB1 = randomUUID();
  const docA1 = randomUUID();

  let prisma: PrismaService;
  let db: TenantPrismaService;

  const position = (tenantId: string, clientId: string, externalId: string) => ({
    tenantId,
    clientId,
    source: "synthetic",
    externalId,
    institution: "XP",
    kind: "investment",
    assetClass: "stock",
    assetCode: "PETR4",
    name: "Petrobras PN",
    quantity: "10",
    valueBrl: "385.00",
    asOf: new Date("2026-11-10"),
  });

  /** Conta as linhas de position de um tenant como dono (fora do código sob teste). */
  const countPositions = async (tenantId: string) => {
    const rows = await migratorSql<{ n: string }>("SELECT count(*) AS n FROM position", [], {
      tenantId,
    });
    return Number(rows[0]?.n);
  };

  beforeAll(async () => {
    await migratorSql(
      `INSERT INTO tenant (id, name, plan) VALUES ($1, 'Tenant A', 'pro'), ($2, 'Tenant B', 'pro')`,
      [tenantA, tenantB],
    );
    await migratorSql(
      `INSERT INTO client (id, tenant_id, external_id) VALUES ($1, $3, 'a1'), ($2, $3, 'a2')`,
      [clientA1, clientA2, tenantA],
      { tenantId: tenantA },
    );
    await migratorSql(
      `INSERT INTO client (id, tenant_id, external_id) VALUES ($1, $2, 'b1')`,
      [clientB1, tenantB],
      { tenantId: tenantB },
    );
    const insertPosition = `INSERT INTO position (tenant_id, client_id, source, external_id,
        institution, kind, asset_class, name, value_brl, as_of)
      VALUES ($1, $2, 'synthetic', $3, 'XP', 'investment', 'stock', 'X', 100, current_date)`;
    await migratorSql(insertPosition, [tenantA, clientA1, "pa1"], { tenantId: tenantA });
    await migratorSql(insertPosition, [tenantA, clientA2, "pa2"], { tenantId: tenantA });
    await migratorSql(insertPosition, [tenantB, clientB1, "pb1"], { tenantId: tenantB });
    const ctxA1 = { tenantId: tenantA, clientId: clientA1 };
    await migratorSql(
      `INSERT INTO kg_document (id, tenant_id, client_id, source, title) VALUES ($1, $2, $3, 'manual', 'Doc')`,
      [docA1, tenantA, clientA1],
      ctxA1,
    );
    await migratorSql(
      `INSERT INTO kg_chunk (tenant_id, client_id, document_id, content) VALUES ($1, $2, $3, 'texto')`,
      [tenantA, clientA1, docA1],
      ctxA1,
    );

    prisma = new PrismaService({ DATABASE_URL: appUrl() });
    db = new TenantPrismaService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("dentro do tenant A, position.findMany não devolve linhas de B", async () => {
    const rows = await TenantContext.run({ tenantId: tenantA }, () =>
      db.client.position.findMany(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tenantId === tenantA)).toBe(true);
  });

  it("create com tenantId de B dentro do tenant A viola o WITH CHECK", async () => {
    await expect(
      TenantContext.run({ tenantId: tenantA }, () =>
        db.client.position.create({ data: position(tenantB, clientB1, `x-${randomUUID()}`) }),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await countPositions(tenantB)).toBe(1);
  });

  it("withClient(A1) não devolve linhas de A2", async () => {
    const rows = await TenantContext.run({ tenantId: tenantA }, () =>
      TenantContext.withClient(clientA1, () => db.client.position.findMany()),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: tenantA, clientId: clientA1 });
  });

  it("withClient(A1): client.findMany devolve só o cliente A1", async () => {
    const rows = await TenantContext.run({ tenantId: tenantA }, () =>
      TenantContext.withClient(clientA1, () => db.client.client.findMany()),
    );
    expect(rows.map((r) => r.id)).toEqual([clientA1]);
  });

  it("kg_chunk exige cliente: só com tenantId não volta nada; com withClient(A1) volta", async () => {
    const withoutClient = await TenantContext.run({ tenantId: tenantA }, () =>
      db.client.kgChunk.findMany(),
    );
    expect(withoutClient).toHaveLength(0);

    const withClient = await TenantContext.run({ tenantId: tenantA }, () =>
      TenantContext.withClient(clientA1, () => db.client.kgChunk.findMany()),
    );
    expect(withClient).toHaveLength(1);
  });

  it("fora de qualquer contexto, position.findMany lança UnauthenticatedError", async () => {
    await expect(db.client.position.findMany()).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  // O contexto é o de quem CRIA a consulta, não o de quem a espera.
  describe("contexto fixado na chamada", () => {
    it("consultas devolvidas num array por withClient(A1) e esperadas em run(A) veem só A1", async () => {
      const [positions, clients] = await TenantContext.run({ tenantId: tenantA }, async () => {
        const queries = await TenantContext.withClient(clientA1, async () => [
          db.client.position.findMany(),
          db.client.client.findMany(),
        ]);
        return Promise.all(queries);
      });
      expect(positions).toHaveLength(1);
      expect(positions).toEqual([
        expect.objectContaining({ tenantId: tenantA, clientId: clientA1 }),
      ]);
      expect(clients).toEqual([expect.objectContaining({ id: clientA1 })]);
    });

    it("consulta criada em run(A) e esperada em run(B) devolve dados de A", async () => {
      const pending = await TenantContext.run({ tenantId: tenantA }, async () => ({
        query: db.client.position.findMany(),
      }));
      const rows = await TenantContext.run({ tenantId: tenantB }, () => pending.query);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.tenantId === tenantA)).toBe(true);
    });

    it("consulta criada fora de contexto rejeita mesmo se esperada dentro de run(A)", async () => {
      const pending = db.client.position.findMany();
      await expect(TenantContext.run({ tenantId: tenantA }, () => pending)).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
    });

    it("client expõe só os modelos: $transaction e SQL bruto não existem", () => {
      const raw = db.client as unknown as Record<string, unknown>;
      for (const key of [
        "$transaction",
        "$queryRaw",
        "$executeRaw",
        "$queryRawUnsafe",
        "$extends",
      ]) {
        expect(raw[key]).toBeUndefined();
      }
    });

    it("API fluente de relações falha alto (TypeError), sem consulta fora do contexto", async () => {
      await TenantContext.run({ tenantId: tenantA }, async () => {
        const found = db.client.client.findUnique({ where: { id: clientA1 } });
        expect(() => found.positions()).toThrow(TypeError);
        await expect(found).resolves.toMatchObject({ id: clientA1 });
      });
    });
  });

  it("tx(): o segundo create falha e o primeiro não é gravado", async () => {
    const before = await countPositions(tenantA);
    const dup = `dup-${randomUUID()}`;
    await expect(
      TenantContext.run({ tenantId: tenantA }, () =>
        db.tx(async (tx) => {
          await tx.position.create({ data: position(tenantA, clientA1, dup) });
          // Viola a unique (tenant_id, client_id, source, external_id).
          await tx.position.create({ data: position(tenantA, clientA1, dup) });
        }),
      ),
      // P2002 (unique) prova que o primeiro create gravou dentro da transação antes do rollback.
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await countPositions(tenantA)).toBe(before);
  });

  it("tx() aplica tenant e cliente do contexto, inclusive com Serializable", async () => {
    const rows = await TenantContext.run({ tenantId: tenantA }, () =>
      TenantContext.withClient(clientA2, () =>
        db.tx((tx) => tx.position.findMany(), { isolation: "Serializable" }),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: tenantA, clientId: clientA2 });
  });

  it("tx() fora de contexto lança UnauthenticatedError", async () => {
    await expect(db.tx((tx) => tx.position.findMany())).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("20 contextos em paralelo, alternando A e B, nunca leem dados um do outro", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const tenantId = i % 2 === 0 ? tenantA : tenantB;
        return TenantContext.run({ tenantId }, async () => {
          const first = await db.client.position.findMany();
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          const second = await db.client.position.findMany();
          return { tenantId, rows: [...first, ...second] };
        });
      }),
    );
    for (const { tenantId, rows } of results) {
      expect(rows.length).toBe(tenantId === tenantA ? 4 : 2);
      expect(rows.every((r) => r.tenantId === tenantId)).toBe(true);
    }
  });

  it("set_config é local à transação: a conexão volta ao pool sem tenant", async () => {
    // Pool de uma conexão: a consulta seguinte usa a mesma conexão física.
    const single = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl(), max: 1 }),
    });
    try {
      const scoped = new TenantPrismaService(single);
      const rows = await TenantContext.run({ tenantId: tenantA, clientId: clientA1 }, () =>
        scoped.client.position.findMany(),
      );
      expect(rows).toHaveLength(1);
      const settings = await single.$queryRaw<{ tenant: string | null; client: string | null }[]>`
        SELECT current_setting('app.tenant_id', true) AS tenant,
               current_setting('app.client_id', true) AS client`;
      expect(settings[0]?.tenant ?? "").toBe("");
      expect(settings[0]?.client ?? "").toBe("");
    } finally {
      await single.$disconnect();
    }
  });

  it("ids que não são uuid falham com ValidationError, sem chegar ao SQL", async () => {
    await expect(
      TenantContext.run({ tenantId: "' OR 1=1 --" }, () => db.client.position.findMany()),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      TenantContext.run({ tenantId: tenantA }, () =>
        TenantContext.withClient("nao-e-uuid", () => db.client.position.findMany()),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("withClient fora de contexto lança UnauthenticatedError; o contexto não vaza após run", async () => {
    await expect(TenantContext.withClient(clientA1, async () => 1)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    await TenantContext.run({ tenantId: tenantA }, async () => {
      expect(TenantContext.current().tenantId).toBe(tenantA);
    });
    expect(() => TenantContext.current()).toThrow(UnauthenticatedError);
  });
});
