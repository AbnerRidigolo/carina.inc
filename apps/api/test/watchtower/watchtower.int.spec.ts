import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import { PrismaService } from "../../src/core/database/prisma.service.js";
import { TenantPrismaService } from "../../src/core/database/tenant-prisma.service.js";
import { ValidationError } from "../../src/core/errors/domain-errors.js";
import { WatchtowerService } from "../../src/modules/watchtower/watchtower.service.js";
import { appUrl, migratorSql } from "../setup/db.js";

describe("WatchtowerService (carina_app, sob RLS)", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const clientA = randomUUID();
  let prisma: PrismaService;
  let db: TenantPrismaService;
  let watchtower: WatchtowerService;

  const inA = <T>(fn: () => Promise<T>) => TenantContext.run({ tenantId: tenantA }, fn);
  const inB = <T>(fn: () => Promise<T>) => TenantContext.run({ tenantId: tenantB }, fn);

  beforeAll(async () => {
    await migratorSql(
      `INSERT INTO tenant (id, name, plan) VALUES ($1, 'A', 'pro'), ($2, 'B', 'pro')`,
      [tenantA, tenantB],
    );
    await migratorSql(
      `INSERT INTO client (id, tenant_id, external_id) VALUES ($1, $2, 'c1')`,
      [clientA, tenantA],
      { tenantId: tenantA },
    );
    prisma = new PrismaService({ DATABASE_URL: appUrl() });
    db = new TenantPrismaService(prisma);
    watchtower = new WatchtowerService(db);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("review grava o evento (digest sha256, flags) e trail o devolve", async () => {
    const responseText =
      "Retorno garantido de 5%. O CPF do titular é 987.654.321-00 (texto-sentinela-9f3a).";
    const out = await inA(() =>
      watchtower.review({
        clientId: clientA,
        channel: "rest",
        query: "como está meu portfólio?",
        agents: ["insight", "risk"],
        responseText,
        durationMs: 120,
      }),
    );
    expect(out.auditId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.flags.map((f) => f.code)).toEqual([
      "suitability.certainty_claim",
      "lgpd.pii_leak.cpf",
    ]);

    const trail = await inA(() => watchtower.trail(100));
    const ev = trail.find((e) => e.id === out.auditId);
    expect(ev).toBeDefined();
    expect(ev).toMatchObject({
      clientId: clientA,
      channel: "rest",
      query: "como está meu portfólio?",
      agents: ["insight", "risk"],
      durationMs: 120,
      flags: out.flags,
    });
    expect(new Date(ev?.createdAt ?? "").toISOString()).toBe(ev?.createdAt);

    const [row] = await migratorSql<{ response_digest: string }>(
      `SELECT response_digest FROM audit_event WHERE id = $1`,
      [out.auditId],
      { tenantId: tenantA },
    );
    expect(row?.response_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.response_digest).toBe(createHash("sha256").update(responseText).digest("hex"));
  });

  it("o banco não guarda o texto da resposta nem a PII (nem dentro de flags)", async () => {
    const sentinel = "sentinela-unica-7c1e";
    const text = `Resposta com ${sentinel}, CPF 111.222.333-44, joao@exemplo.com e retorno garantido.`;
    const out = await inA(() =>
      watchtower.review({
        channel: "ws",
        query: "q",
        agents: ["a"],
        responseText: text,
        durationMs: 1,
      }),
    );
    const [row] = await migratorSql<{ dump: string }>(
      `SELECT audit_event::text AS dump FROM audit_event WHERE id = $1`,
      [out.auditId],
      { tenantId: tenantA },
    );
    expect(row?.dump).toBeDefined();
    for (const needle of [sentinel, "111.222.333-44", "joao@exemplo.com", "Resposta com"]) {
      expect(row?.dump).not.toContain(needle);
    }
    // O trecho mínimo da certeza é permitido, como no Python.
    expect(row?.dump).toContain("retorno garantido");
  });

  it("clientId é opcional (NULL) e o evento volta sem clientId", async () => {
    const out = await inA(() =>
      watchtower.review({
        channel: "worker",
        query: "q",
        agents: [],
        responseText: "Tudo certo.",
        durationMs: 0,
      }),
    );
    expect(out.flags).toEqual([]);
    const ev = (await inA(() => watchtower.trail(500))).find((e) => e.id === out.auditId);
    expect(ev).toBeDefined();
    expect(ev && "clientId" in ev).toBe(false);
  });

  it("trail: mais recentes primeiro, respeita o limit e isola por tenant", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const out = await inB(() =>
        watchtower.review({
          channel: "rest",
          query: `q${i}`,
          agents: [],
          responseText: `r${i}`,
          durationMs: i,
        }),
      );
      ids.push(out.auditId);
    }
    const newestFirst = [...ids].reverse();
    expect((await inB(() => watchtower.trail(100))).map((e) => e.id)).toEqual(newestFirst);
    expect((await inB(() => watchtower.trail(2))).map((e) => e.id)).toEqual(
      newestFirst.slice(0, 2),
    );
    // A não enxerga B.
    const a = await inA(() => watchtower.trail(500));
    expect(a.some((e) => ids.includes(e.id))).toBe(false);
  });

  it("trail: limit acima de 500 é limitado a 500; limit inválido → ValidationError", async () => {
    const tenantC = randomUUID();
    await migratorSql(`INSERT INTO tenant (id, name, plan) VALUES ($1, 'C', 'pro')`, [tenantC]);
    await migratorSql(
      `INSERT INTO audit_event (tenant_id, channel, query)
       SELECT $1, 'rest', 'q' || g FROM generate_series(1, 505) g`,
      [tenantC],
      { tenantId: tenantC },
    );
    const inC = <T>(fn: () => Promise<T>) => TenantContext.run({ tenantId: tenantC }, fn);
    expect(await inC(() => watchtower.trail(10_000))).toHaveLength(500);
    expect(await inC(() => watchtower.trail(500))).toHaveLength(500);
    expect(await inC(() => watchtower.trail())).toHaveLength(100);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(inA(() => watchtower.trail(bad))).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("review dentro de tx entra na transação do chamador e desfaz junto", async () => {
    const marker = randomUUID();
    await expect(
      inA(() =>
        db.tx(async (tx) => {
          await watchtower.review({
            tx,
            channel: "rest",
            query: marker,
            agents: [],
            responseText: "x",
            durationMs: 0,
          });
          throw new Error("rollback");
        }),
      ),
    ).rejects.toThrow("rollback");
    expect((await inA(() => watchtower.trail(500))).some((e) => e.query === marker)).toBe(false);

    const kept = await inA(() =>
      db.tx((tx) =>
        watchtower.review({
          tx,
          channel: "rest",
          query: marker,
          agents: [],
          responseText: "x",
          durationMs: 0,
        }),
      ),
    );
    expect((await inA(() => watchtower.trail(500))).some((e) => e.id === kept.auditId)).toBe(true);
  });

  it("sem TenantContext, review e trail rejeitam sem tocar no banco", async () => {
    await expect(
      watchtower.review({
        channel: "rest",
        query: "q",
        agents: [],
        responseText: "x",
        durationMs: 0,
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(watchtower.trail(10)).rejects.toMatchObject({ status: 401 });
  });

  it("a trilha é append-only para carina_app (UPDATE/DELETE negados)", async () => {
    const out = await inA(() =>
      watchtower.review({
        channel: "rest",
        query: "q",
        agents: [],
        responseText: "x",
        durationMs: 0,
      }),
    );
    await expect(
      inA(() => db.client.auditEvent.update({ where: { id: out.auditId }, data: { query: "z" } })),
    ).rejects.toThrow();
    await expect(
      inA(() => db.client.auditEvent.delete({ where: { id: out.auditId } })),
    ).rejects.toThrow();
  });
});
