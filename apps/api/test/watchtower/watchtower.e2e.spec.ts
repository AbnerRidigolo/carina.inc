import { AuditEventViewSchema, ProblemSchema } from "@carina/shared";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import { WatchtowerModule } from "../../src/modules/watchtower/watchtower.module.js";
import { WatchtowerService } from "../../src/modules/watchtower/watchtower.service.js";
import { createTestApp, type SeededTenant, type TestApp } from "../setup/app.js";
import { redisDbOf } from "../setup/redis-dbs.js";

describe("Watchtower E2E: GET /api/audit", () => {
  let t: TestApp;
  let server: Parameters<typeof request>[0];
  let A: SeededTenant;
  let B: SeededTenant;
  let watchtower: WatchtowerService;

  const seed = (tenant: SeededTenant, n: number, prefix: string) =>
    TenantContext.run({ tenantId: tenant.tenantId }, async () => {
      for (let i = 0; i < n; i++) {
        await watchtower.review({
          channel: "rest",
          query: `${prefix}-${i}`,
          agents: ["insight"],
          responseText: i === 0 ? "Retorno garantido." : "Tudo certo.",
          durationMs: i,
        });
      }
    });

  beforeAll(async () => {
    t = await createTestApp({
      imports: [WatchtowerModule],
      redisDb: redisDbOf("watchtower/watchtower.e2e.spec.ts"),
    });
    server = t.app.getHttpServer() as Parameters<typeof request>[0];
    watchtower = t.app.get(WatchtowerService);
    A = await t.seedTenant({ name: "A" });
    B = await t.seedTenant({ name: "B" });
    await seed(A, 3, "a");
    await seed(B, 2, "b");
  });

  afterAll(async () => {
    await t.close();
  });

  const get = (path: string, key?: string) =>
    request(server)
      .get(path)
      .set(key ? { Authorization: `Bearer ${key}` } : {});

  const parse = (body: unknown) => AuditEventViewSchema.array().parse(body);

  it("devolve a trilha do tenant da chave, mais recentes primeiro", async () => {
    const res = await get("/api/audit", A.keys.chat);
    expect(res.status).toBe(200);
    const events = parse(res.body);
    expect(events.map((e) => e.query)).toEqual(["a-2", "a-1", "a-0"]);
    expect(events[2]?.flags.map((f) => f.code)).toEqual(["suitability.certainty_claim"]);
  });

  it("isolamento: o tenant A nunca vê eventos do B, e vice-versa", async () => {
    const a = parse((await get("/api/audit", A.keys.chat)).body);
    const b = parse((await get("/api/audit", B.keys.chat)).body);
    expect(a.some((e) => e.query.startsWith("b-"))).toBe(false);
    expect(b.map((e) => e.query)).toEqual(["b-1", "b-0"]);
  });

  it("?limit= restringe a quantidade", async () => {
    const res = await get("/api/audit?limit=2", A.keys.chat);
    expect(res.status).toBe(200);
    expect(parse(res.body).map((e) => e.query)).toEqual(["a-2", "a-1"]);
  });

  it("limit acima de 500 é aceito e limitado a 500", async () => {
    const res = await get("/api/audit?limit=100000", A.keys.chat);
    expect(res.status).toBe(200);
    expect(parse(res.body)).toHaveLength(3);
  });

  it.each(["abc", "0", "-3", "1.5", "", "2x"])(
    "limit inválido (%j) → 422 problem+json",
    async (bad) => {
      const res = await get(`/api/audit?limit=${encodeURIComponent(bad)}`, A.keys.chat);
      expect(res.status).toBe(422);
      expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
      expect(ProblemSchema.parse(res.body).status).toBe(422);
    },
  );

  it("a pergunta gravada é mascarada (PII) e truncada; a resposta segue só como digest", async () => {
    const C = await t.seedTenant({ name: "PII" });
    const query = `meu cpf é 123.456.789-09 e o e-mail joao@exemplo.com ${"y".repeat(800)}`;
    await TenantContext.run({ tenantId: C.tenantId }, () =>
      watchtower.review({
        channel: "rest",
        query,
        agents: [],
        responseText: "CPF 987.654.321-00",
        durationMs: 1,
      }),
    );
    const res = await request(server)
      .get("/api/audit")
      .set("Authorization", `Bearer ${C.keys.chat}`);
    expect(res.status).toBe(200);
    const [ev] = (res.body as unknown[]).map((e) => AuditEventViewSchema.parse(e));
    expect(ev?.query.startsWith("meu cpf é [cpf] e o e-mail [email] ")).toBe(true);
    expect(ev?.query).not.toContain("123.456.789-09");
    expect(ev?.query).not.toContain("joao@exemplo.com");
    expect([...(ev?.query ?? "")].length).toBe(500);
    // As flags (da resposta) seguem preservadas.
    expect(ev?.flags.map((f) => f.code)).toEqual(["lgpd.pii_leak.cpf"]);
  });

  it("sem chave: 401; sem o escopo chat: 403", async () => {
    expect((await get("/api/audit")).status).toBe(401);
    expect((await get("/api/audit", A.keys.ingest)).status).toBe(403);
  });
});
