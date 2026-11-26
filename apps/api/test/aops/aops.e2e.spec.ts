/**
 * Rotas /api/aops/*: escopo `aops:manage`, AOPs por tenant (RLS), compilação sem cobrança, disparo
 * manual (202, 1 por minuto por AOP → 409) executado pelo worker de verdade (AopJob consumindo o
 * stream `jobs`, LLM_MODE=mock) e histórico paginado. Redis: DB lógico próprio
 * (test/setup/redis-dbs.ts), esvaziado a cada teste. O tick da agenda fica em 1 h para não disparar
 * nada fora dos testes.
 */
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { AopRunPageSchema, AopSchema, UsageSummarySchema } from "@carina/shared";
import { Redis } from "ioredis";
import { Logger as PinoLogger } from "nestjs-pino";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LoggingModule } from "../../src/core/logging/logging.module.js";
import { AopsModule } from "../../src/modules/aops/aops.module.js";
import { BillingModule } from "../../src/modules/billing/billing.module.js";
import { createTestApp, type SeededTenant, type TestApp } from "../setup/app.js";
import { migratorSql, must, redisDbUrl } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

const REDIS_DB = redisDbOf("aops/aops.e2e.spec.ts");
const BASE = "/api/aops";
const UNKNOWN_ID = "11111111-1111-4111-8111-111111111111";
const DESCRIPTION = "Toda sexta às 9h, faça a análise do portfólio e do risco dos clientes premium";

const lines: string[] = [];
const destination = new Writable({
  write(chunk: Buffer, _enc, cb) {
    lines.push(...chunk.toString().split("\n").filter(Boolean));
    cb();
  },
});

describe("AOPs E2E", () => {
  let t: TestApp;
  let A: SeededTenant;
  let B: SeededTenant;
  let server: Parameters<typeof request>[0];
  let redis: Redis;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [LoggingModule.forRoot({ destination }), AopsModule, BillingModule],
      redisDb: REDIS_DB,
      workersEnabled: true,
      env: { LOG_LEVEL: "info", AOP_TICK_MS: "3600000" },
    });
    // `createTestApp` cria o app com `logger: false`: sem isto o Logger do Nest (o do controller)
    // nunca chega ao pino e os asserts de log passariam sem observar nada. Igual ao bootstrap.
    t.app.useLogger(t.app.get(PinoLogger));
    server = t.app.getHttpServer() as Parameters<typeof request>[0];
    A = await t.seedTenant({ name: "AOPs A" });
    B = await t.seedTenant({ name: "AOPs B" });
    for (const ext of ["c-1", "c-2"]) {
      await migratorSql(
        `INSERT INTO client (id, tenant_id, external_id) VALUES ($1, $2, $3)`,
        [randomUUID(), A.tenantId, ext],
        { tenantId: A.tenantId },
      );
    }
    redis = new Redis(redisDbUrl(REDIS_DB));
  });
  afterAll(async () => {
    await redis.quit();
    await t.close();
  });
  beforeEach(async () => {
    // Só as chaves do guard manual: o consumidor do stream `jobs` segue vivo neste DB.
    const keys = await redis.keys("aop:manual:*");
    if (keys.length > 0) await redis.del(...keys);
  });

  const auth = (k?: string): Record<string, string> => (k ? { Authorization: `Bearer ${k}` } : {});
  const get = (path: string, k?: string) => request(server).get(path).set(auth(k));
  const post = (path: string, body: unknown, k?: string) =>
    request(server)
      .post(path)
      .set(auth(k))
      .send(body as object);
  const patch = (path: string, body: unknown, k?: string) =>
    request(server)
      .patch(path)
      .set(auth(k))
      .send(body as object);
  const create = async (
    T: SeededTenant,
    body: object = { description: DESCRIPTION, clientIds: ["c-1", "c-2"] },
  ) => AopSchema.parse((await post(BASE, body, T.keys.aops).expect(201)).body);
  const runsOf = async (T: SeededTenant, id: string, query = "") =>
    AopRunPageSchema.parse((await get(`${BASE}/${id}/runs${query}`, T.keys.aops).expect(200)).body);
  const waitRuns = async (T: SeededTenant, id: string, n: number) => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const page = await runsOf(T, id, "?limit=50");
      if (page.items.length >= n) return page;
      if (Date.now() > deadline) throw new Error(`o worker não gravou ${String(n)} execuções`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const aopUsage = async (T: SeededTenant) => {
    const res = await get("/api/usage", T.keys.chat);
    return UsageSummarySchema.parse(res.body).byWorkType;
  };

  it("sem aops:manage → 403 problem+json; sem chave → 401", async () => {
    const res = await get(BASE, A.keys.builder);
    expect(res.status).toBe(403);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    await post(BASE, { description: DESCRIPTION, clientIds: ["c-1"] }, A.keys.chat).expect(403);
    await post(`${BASE}/${UNKNOWN_ID}/run`, {}, A.keys.chat).expect(403);
    await get(BASE).expect(401);
  });

  it("cria (201) compilando, lista e lê; criar não cobra", async () => {
    const before = await aopUsage(A);
    const created = await create(A);
    expect(created.agents).toEqual(["insight", "risk"]);
    expect(created.schedule).toEqual({ frequency: "weekly", weekday: 4, day: 1, hour: 9 });
    expect(created.clientIds).toEqual(["c-1", "c-2"]);
    expect(created.enabled).toBe(true);
    expect(created.description).toBe(DESCRIPTION);
    const listed = (await get(BASE, A.keys.aops).expect(200)).body as { id: string }[];
    expect(listed.map((a) => a.id)).toContain(created.id);
    const read = AopSchema.parse(
      (await get(`${BASE}/${created.id}`, A.keys.aops).expect(200)).body,
    );
    expect(read).toEqual(created);
    expect(await aopUsage(A)).toEqual(before);
  });

  it("nome informado vale; sem nome, vem da compilação", async () => {
    const named = await create(A, {
      description: DESCRIPTION,
      clientIds: ["c-1"],
      name: "Meu AOP",
    });
    expect(named.name).toBe("Meu AOP");
    const auto = await create(A, { description: DESCRIPTION, clientIds: ["c-1"] });
    expect(auto.name.length).toBeGreaterThan(0);
  });

  it("descrição sem agentes → 422 com a lista de agentes", async () => {
    const res = await post(
      BASE,
      { description: "bom dia, tudo bem?", clientIds: ["c-1"] },
      A.keys.aops,
    );
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain("insight");
  });

  it("clientIds vazio ou com 21 ids → 422; id desconhecido é aceito (vira client_not_found na execução)", async () => {
    await post(BASE, { description: DESCRIPTION, clientIds: [] }, A.keys.aops).expect(422);
    const many = Array.from({ length: 21 }, (_, i) => `x-${String(i)}`);
    await post(BASE, { description: DESCRIPTION, clientIds: many }, A.keys.aops).expect(422);
    const twenty = Array.from({ length: 20 }, (_, i) => `x-${String(i)}`);
    await post(BASE, { description: DESCRIPTION, clientIds: twenty }, A.keys.aops).expect(201);
    await post(BASE, { description: "", clientIds: ["c-1"] }, A.keys.aops).expect(422);
    await post(
      BASE,
      { description: DESCRIPTION, clientIds: ["c-1"], agents: ["executor"] },
      A.keys.aops,
    ).expect(422);
  });

  it("outro tenant → 404 em ler, PATCH, run e runs; a lista não vaza", async () => {
    const mine = await create(A);
    const k = B.keys.aops;
    await get(`${BASE}/${mine.id}`, k).expect(404);
    await patch(`${BASE}/${mine.id}`, { enabled: false }, k).expect(404);
    await post(`${BASE}/${mine.id}/run`, {}, k).expect(404);
    await get(`${BASE}/${mine.id}/runs`, k).expect(404);
    await get(`${BASE}/não-é-uuid`, k).expect(404);
    const listed = (await get(BASE, k).expect(200)).body as { id: string }[];
    expect(listed.map((a) => a.id)).not.toContain(mine.id);
    // O dono segue intacto.
    expect(
      AopSchema.parse((await get(`${BASE}/${mine.id}`, A.keys.aops).expect(200)).body).enabled,
    ).toBe(true);
  });

  it("PATCH liga e desliga; corpo inválido → 422", async () => {
    const aop = await create(A);
    const off = AopSchema.parse(
      (await patch(`${BASE}/${aop.id}`, { enabled: false }, A.keys.aops).expect(200)).body,
    );
    expect(off.enabled).toBe(false);
    const on = AopSchema.parse(
      (await patch(`${BASE}/${aop.id}`, { enabled: true }, A.keys.aops).expect(200)).body,
    );
    expect(on.enabled).toBe(true);
    await patch(`${BASE}/${aop.id}`, {}, A.keys.aops).expect(422);
    await patch(`${BASE}/${aop.id}`, { enabled: true, name: "x" }, A.keys.aops).expect(422);
  });

  it("run → 202 e o worker grava a execução; last_fire_at não muda; segundo run no mesmo minuto → 409", async () => {
    const aop = await create(A, { description: DESCRIPTION, clientIds: ["c-1", "c-2", "ghost"] });
    const antes = Date.now();
    const res = await post(`${BASE}/${aop.id}/run`, {}, A.keys.aops);
    const depois = Date.now();
    expect(res.status).toBe(202);
    const { fireAt } = res.body as { fireAt: string };
    expect(new Date(fireAt).toISOString()).toBe(fireAt);
    // Precisão de milissegundos, nunca truncado ao minuto: um fireAt truncado poderia colidir com
    // o `previousFire` agendado no único de aop_run e pular os clientes do disparo agendado.
    expect(Date.parse(fireAt)).toBeGreaterThanOrEqual(antes);
    expect(Date.parse(fireAt)).toBeLessThanOrEqual(depois);

    // c-1 e c-2 executam; "ghost" (client_not_found) não é gravado (limitação documentada).
    const page = await waitRuns(A, aop.id, 2);
    expect(page.items.map((r) => r.clientId).sort()).toEqual(["c-1", "c-2"]);
    for (const r of page.items) {
      expect(r.trigger).toBe("manual");
      expect(r.status).toBe("ok");
      expect(r.fireAt).toBe(fireAt);
    }
    expect(
      AopSchema.parse((await get(`${BASE}/${aop.id}`, A.keys.aops)).body).lastFireAt,
    ).toBeNull();

    const again = await post(`${BASE}/${aop.id}/run`, {}, A.keys.aops);
    expect(again.status).toBe(409);
    expect(again.headers["content-type"]).toContain("application/problem+json");
    expect(Number(again.headers["retry-after"])).toBeGreaterThan(0);
    // Outro AOP não é afetado pelo limite do primeiro.
    const other = await create(A);
    await post(`${BASE}/${other.id}/run`, {}, A.keys.aops).expect(202);
  });

  it("run de AOP desligado → 409 e não consome o minuto", async () => {
    const aop = await create(A);
    await patch(`${BASE}/${aop.id}`, { enabled: false }, A.keys.aops).expect(200);
    await post(`${BASE}/${aop.id}/run`, {}, A.keys.aops).expect(409);
    await patch(`${BASE}/${aop.id}`, { enabled: true }, A.keys.aops).expect(200);
    await post(`${BASE}/${aop.id}/run`, {}, A.keys.aops).expect(202);
  });

  it("run de id inexistente → 404 sem tocar o guard do minuto", async () => {
    await post(`${BASE}/${UNKNOWN_ID}/run`, {}, A.keys.aops).expect(404);
    expect(await redis.keys("aop:manual:*")).toEqual([]);
  });

  it("runs pagina (mais novos primeiro), valida limit e cursor", async () => {
    const aop = await create(A, { description: DESCRIPTION, clientIds: ["c-1", "c-2"] });
    await post(`${BASE}/${aop.id}/run`, {}, A.keys.aops).expect(202);
    await waitRuns(A, aop.id, 2);
    const first = await runsOf(A, aop.id, "?limit=1");
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await runsOf(
      A,
      aop.id,
      `?limit=1&cursor=${encodeURIComponent(must(first.nextCursor))}`,
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    for (const bad of ["limit=0", "limit=51", "limit=abc", "cursor=lixo"]) {
      await get(`${BASE}/${aop.id}/runs?${bad}`, A.keys.aops).expect(422);
    }
  });

  it("nenhum log contém a descrição", async () => {
    const secret = "SEGREDO-do-procedimento-9f3a: toda sexta às 9h, analise o risco";
    const aop = await create(A, { description: secret, clientIds: ["c-1"] });
    await post(`${BASE}/${aop.id}/run`, {}, A.keys.aops).expect(202);
    await waitRuns(A, aop.id, 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(lines.length).toBeGreaterThan(0);
    // O logger realmente captura as rotas: sem isto, "não contém" passaria com logs vazios.
    expect(lines.some((l) => l.includes("Procedimento criado") && l.includes(aop.id))).toBe(true);
    expect(lines.some((l) => l.includes("Disparo manual solicitado") && l.includes(aop.id))).toBe(
      true,
    );
    expect(lines.join("\n")).not.toContain("SEGREDO");
  });
});
