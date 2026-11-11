import request from "supertest";
import { ProblemSchema } from "@carina/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migratorSql } from "../setup/db.js";
import { createTestApp, type SeededTenant, type TestApp } from "../setup/app.js";

describe("Tenancy E2E: chaves de API, escopos e clientes", () => {
  let t: TestApp;
  let server: Parameters<typeof request>[0];
  let A: SeededTenant;
  let B: SeededTenant;
  const clientIds: Record<string, string> = {};

  const insertClient = async (tenantId: string, externalId: string) => {
    const [row] = await migratorSql<{ id: string }>(
      `INSERT INTO client (tenant_id, external_id) VALUES ($1, $2) RETURNING id`,
      [tenantId, externalId],
      { tenantId },
    );
    if (!row) throw new Error("INSERT INTO client não devolveu id");
    clientIds[`${tenantId}:${externalId}`] = row.id;
    return row.id;
  };

  const insertPosition = (tenantId: string, clientId: string, externalId: string) =>
    migratorSql(
      `INSERT INTO position (tenant_id, client_id, source, external_id, institution, kind,
         asset_class, name, value_brl, as_of)
       VALUES ($1, $2, 'synthetic', $3, 'XP', 'investment', 'stock', 'X', 100.50, current_date)`,
      [tenantId, clientId, externalId],
      { tenantId },
    );

  const expectProblem = (res: request.Response, status: number) => {
    expect(res.status).toBe(status);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    const problem = ProblemSchema.parse(res.body);
    expect(problem.status).toBe(status);
    return problem;
  };

  /** O traceId muda a cada requisição; o resto do problema deve ser idêntico. */
  const withoutTraceId = (problem: object) => ({ ...problem, traceId: undefined });

  beforeAll(async () => {
    t = await createTestApp();
    server = t.app.getHttpServer() as Parameters<typeof request>[0];
    A = await t.seedTenant({ name: "Tenant A" });
    B = await t.seedTenant({ name: "Tenant B" });
    const a1 = await insertClient(A.tenantId, "a1");
    const a2 = await insertClient(A.tenantId, "a2");
    const b1 = await insertClient(B.tenantId, "b1");
    // Mesmo externalId em dois tenants: a resolução precisa ser por tenant.
    const bShared = await insertClient(B.tenantId, "shared");
    const aShared = await insertClient(A.tenantId, "shared");
    await insertPosition(A.tenantId, a1, "pa1");
    await insertPosition(A.tenantId, a2, "pa2");
    await insertPosition(A.tenantId, aShared, "pas");
    await insertPosition(B.tenantId, b1, "pb1");
    await insertPosition(B.tenantId, bShared, "pbs");
  });

  afterAll(async () => {
    await t?.close();
  });

  describe("autenticação", () => {
    it("GET /api/clients sem chave → 401 application/problem+json", async () => {
      const res = await request(server).get("/api/clients");
      const problem = expectProblem(res, 401);
      expect(problem.type).toMatch(/unauthenticated$/);
    });

    it("chave revogada → 401, com a mesma resposta de chave desconhecida", async () => {
      const revoked = await t.createKey(A.tenantId, { scopes: ["chat"], revoked: true });
      const unknown = "sk-live-" + "x".repeat(32);
      const r1 = await request(server)
        .get("/api/clients")
        .set("Authorization", `Bearer ${revoked}`);
      const r2 = await request(server)
        .get("/api/clients")
        .set("Authorization", `Bearer ${unknown}`);
      const r3 = await request(server).get("/api/clients");
      const strip = (res: request.Response) => withoutTraceId(expectProblem(res, 401));
      expect(strip(r1)).toEqual(strip(r2));
      expect(strip(r2)).toEqual(strip(r3));
    });

    it("chave revogada depois de usada deixa de autenticar", async () => {
      const key = await t.createKey(A.tenantId, { scopes: ["chat"] });
      await request(server).get("/api/clients").set("X-API-Key", key).expect(200);
      await t.revokeKey(key);
      expectProblem(await request(server).get("/api/clients").set("X-API-Key", key), 401);
    });

    it("a resposta 401 não ecoa a chave nem o hash", async () => {
      const key = "sk-live-" + "q".repeat(32);
      const res = await request(server).get("/api/clients").set("X-API-Key", key);
      expectProblem(res, 401);
      expect(res.text).not.toContain(key);
      expect(res.text).not.toContain("q".repeat(32));
    });
  });

  describe("escopos", () => {
    it("chave sem o escopo chat em GET /api/clients → 403", async () => {
      const res = await request(server).get("/api/clients").set("X-API-Key", A.keys.ingest);
      const problem = expectProblem(res, 403);
      expect(problem.type).toMatch(/forbidden_scope$/);
    });

    it("chave com scopes NULL no banco é tratada como sem escopos → 403 (não 500)", async () => {
      const key = await t.createKey(A.tenantId, { scopes: null });
      expectProblem(await request(server).get("/api/clients").set("X-API-Key", key), 403);
    });
  });

  describe("GET /api/clients", () => {
    it("com a chave do tenant A → só os clientes de A", async () => {
      const res = await request(server)
        .get("/api/clients")
        .set("Authorization", `Bearer ${A.keys.chat}`)
        .expect(200);
      const body = res.body as { id: string; externalId: string; createdAt: string }[];
      expect(body.map((c) => c.externalId).sort()).toEqual(["a1", "a2", "shared"]);
      expect(body.map((c) => c.id).sort()).toEqual(
        [
          clientIds[`${A.tenantId}:a1`],
          clientIds[`${A.tenantId}:a2`],
          clientIds[`${A.tenantId}:shared`],
        ].sort(),
      );
      for (const c of body) expect(Number.isNaN(Date.parse(c.createdAt))).toBe(false);
    });

    it("requisições concorrentes de A e B não misturam os contextos", async () => {
      const call = (key: string) =>
        request(server).get("/api/clients").set("X-API-Key", key).expect(200);
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, i) => call(i % 2 === 0 ? A.keys.chat : B.keys.approver)),
      );
      responses.forEach((res, i) => {
        const ids = (res.body as { externalId: string }[]).map((c) => c.externalId).sort();
        expect(ids).toEqual(i % 2 === 0 ? ["a1", "a2", "shared"] : ["b1", "shared"]);
      });
    });
  });

  describe("GET /api/clients/:clientId/positions", () => {
    it("cliente do próprio tenant → 200 só com as posições dele", async () => {
      const res = await request(server)
        .get("/api/clients/a1/positions")
        .set("X-API-Key", A.keys.chat)
        .expect(200);
      const body = res.body as { externalId: string; clientId: string; valueBrl: string }[];
      expect(body.map((p) => p.externalId)).toEqual(["pa1"]);
      expect(body[0]?.clientId).toBe(clientIds[`${A.tenantId}:a1`]);
      expect(body[0]?.valueBrl).toBe("100.5");
    });

    it("externalId repetido entre tenants resolve para o cliente do tenant da chave", async () => {
      const res = await request(server)
        .get("/api/clients/shared/positions")
        .set("X-API-Key", B.keys.chat)
        .expect(200);
      expect((res.body as { externalId: string }[]).map((p) => p.externalId)).toEqual(["pbs"]);
    });

    it("externalId de B com a chave de A → 404, igual a um cliente inexistente", async () => {
      const cross = await request(server)
        .get("/api/clients/b1/positions")
        .set("X-API-Key", A.keys.chat);
      const missing = await request(server)
        .get("/api/clients/nao-existe/positions")
        .set("X-API-Key", A.keys.chat);
      expect(withoutTraceId(expectProblem(cross, 404))).toEqual(
        withoutTraceId(expectProblem(missing, 404)),
      );
      expect(cross.text).not.toContain(clientIds[`${B.tenantId}:b1`]);
    });

    it("o id interno (uuid) de um cliente de B também → 404", async () => {
      const res = await request(server)
        .get(`/api/clients/${clientIds[`${B.tenantId}:b1`]}/positions`)
        .set("X-API-Key", A.keys.chat);
      expectProblem(res, 404);
    });

    it("clientId malformado → 4xx, nunca 500", async () => {
      for (const id of ["%00", "a%00b", "x".repeat(129), "%E2%80%8B%0A"]) {
        const res = await request(server)
          .get(`/api/clients/${id}/positions`)
          .set("X-API-Key", A.keys.chat);
        expect(res.status, id).toBeGreaterThanOrEqual(400);
        expect(res.status, id).toBeLessThan(500);
        expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
      }
    });

    it("sem o escopo chat → 403; sem chave → 401", async () => {
      expectProblem(
        await request(server).get("/api/clients/a1/positions").set("X-API-Key", A.keys.ingest),
        403,
      );
      expectProblem(await request(server).get("/api/clients/a1/positions"), 401);
    });
  });
});
