/**
 * Chat REST (`POST /api/chat`) e emissão de ticket (`POST /api/ws/ticket`), com Postgres, Redis e
 * o grafo reais em LLM_MODE=mock: cobrança e auditoria atômicas, cota devolvida em toda falha,
 * isolamento de threads, serialização de turnos por thread e cancelamento pelo cliente.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { ChatResponseSchema, ProblemSchema, WsTicketSchema } from "@carina/shared";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LockService } from "../../src/core/redis/lock.service.js";
import { ChatModule } from "../../src/modules/chat/chat.module.js";
import { threadLockKey } from "../../src/modules/chat/chat.service.js";
import { WsTicketService } from "../../src/modules/chat/ws-ticket.service.js";
import { monthKey } from "../../src/modules/limits/month.js";
import { MockResponderRegistry } from "../../src/modules/llm/mock-models.js";
import { createTestApp, type SeededTenant, type TestApp } from "../setup/app.js";
import { migratorSql, must, redisDbUrl } from "../setup/db.js";
import { FailingMockRegistry, eventually, gateOrchestrator } from "./helpers.js";
import { redisDbOf } from "../setup/redis-dbs.js";

const REDIS_DB = redisDbOf("chat/chat.e2e.spec.ts");
const QUOTA = 1000;

describe("Chat REST", () => {
  let t: TestApp;
  let redis: Redis;
  let server: Parameters<typeof request>[0];
  let A: SeededTenant;
  let B: SeededTenant;
  const mocks = new FailingMockRegistry();

  const post = (key: string | undefined, body: unknown) => {
    const r = request(server).post("/api/chat");
    return (key ? r.set("Authorization", `Bearer ${key}`) : r).send(body as object);
  };
  const quotaKey = (tenantId: string) => `quota:${tenantId}:${monthKey(Date.now())}`;
  const count = async (table: "usage_record" | "audit_event", tenantId: string) =>
    Number(
      must(
        (
          await migratorSql<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`, [], {
            tenantId,
          })
        )[0],
      ).n,
    );
  const clientUuid = async (tenantId: string, externalId: string) =>
    must(
      (
        await migratorSql<{ id: string }>(
          `SELECT id FROM client WHERE external_id = $1`,
          [externalId],
          {
            tenantId,
          },
        )
      )[0],
    ).id;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [ChatModule],
      redisDb: REDIS_DB,
      overrides: [{ token: MockResponderRegistry, useValue: mocks }],
    });
    server = t.app.getHttpServer() as Parameters<typeof request>[0];
    redis = new Redis(redisDbUrl(REDIS_DB));
    A = await t.seedTenant({ name: "Chat A", monthlyQuota: QUOTA });
    B = await t.seedTenant({ name: "Chat B", monthlyQuota: QUOTA });
  });

  afterAll(async () => {
    await t?.close();
    await redis?.quit();
  });

  beforeEach(async () => {
    mocks.failing = false;
    await redis.flushdb();
  });

  it('"olá": 200 completed, query a R$ 1,50, um usage_record e um audit_event (canal rest)', async () => {
    const usage0 = await count("usage_record", A.tenantId);
    const audit0 = await count("audit_event", A.tenantId);
    const res = await post(A.keys.chat, { clientId: "cli-1", message: "olá" });
    expect(res.status).toBe(200);
    const body = ChatResponseSchema.parse(res.body);
    expect(body.status).toBe("completed");
    expect(body.usage).toEqual({ workType: "query", priceBrl: "1.50" });
    expect(body.answer.length).toBeGreaterThan(0);
    expect(body.approval).toBeUndefined();
    const cli = await clientUuid(A.tenantId, "cli-1");
    expect(body.threadId.startsWith(`${A.tenantId}:${cli}:`)).toBe(true);

    expect(await count("usage_record", A.tenantId)).toBe(usage0 + 1);
    expect(await count("audit_event", A.tenantId)).toBe(audit0 + 1);
    const [audit] = await migratorSql<{ id: string; channel: string; client_id: string }>(
      `SELECT id, channel, client_id FROM audit_event WHERE id = $1`,
      [body.compliance.auditId],
      { tenantId: A.tenantId },
    );
    expect(audit).toEqual({ id: body.compliance.auditId, channel: "rest", client_id: cli });
    // A cota foi consumida (uma unidade) e o lock do thread foi liberado.
    expect(await redis.get(quotaKey(A.tenantId))).toBe("1");
    expect(await redis.exists(threadLockKey(body.threadId))).toBe(0);
  });

  it("risco + projeção: multi_agent_analysis a R$ 15,00 com o resultado de cada especialista", async () => {
    const res = await post(A.keys.chat, {
      clientId: "cli-1",
      message: "qual o risco e a projeção da minha carteira?",
    });
    expect(res.status).toBe(200);
    const body = ChatResponseSchema.parse(res.body);
    expect(body.usage).toEqual({ workType: "multi_agent_analysis", priceBrl: "15.00" });
    expect(body.plan.agents).toEqual(expect.arrayContaining(["predictor", "risk"]));
    expect(Object.keys(body.results).sort()).toEqual([...body.plan.agents].sort());
  });

  it("compra: awaiting_approval com a ApprovalView (R$ 3.000,00) pendente no banco", async () => {
    const res = await post(A.keys.chat, {
      clientId: "cli-1",
      message: "compre 100 ações de PETR4",
    });
    expect(res.status).toBe(200);
    const body = ChatResponseSchema.parse(res.body);
    expect(body.status).toBe("awaiting_approval");
    expect(body.approval).toMatchObject({
      valueBrl: "3000.00",
      status: "pending",
      clientId: "cli-1",
    });
    const [row] = await migratorSql<{ status: string; thread_id: string }>(
      `SELECT status, thread_id FROM approval_request WHERE id = $1`,
      [must(body.approval).id],
      { tenantId: A.tenantId },
    );
    expect(row).toEqual({ status: "pending", thread_id: body.threadId });

    // Turno novo no thread parado: 409 (aprovação pendente) e a cota volta.
    const again = await post(A.keys.chat, {
      clientId: "cli-1",
      message: "olá",
      threadId: body.threadId,
    });
    expect(again.status).toBe(409);
    expect(await redis.get(quotaKey(A.tenantId))).toBe("1");

    // Rejeitada: o próximo turno no mesmo thread cura a espera e completa.
    const decided = await request(server)
      .post(`/api/inbox/${must(body.approval).id}/decision`)
      .set("Authorization", `Bearer ${A.keys.approver}`)
      .send({ approved: false });
    expect(decided.status).toBe(200);
    const healed = await post(A.keys.chat, {
      clientId: "cli-1",
      message: "olá",
      threadId: body.threadId,
    });
    expect(healed.status).toBe(200);
    expect(ChatResponseSchema.parse(healed.body)).toMatchObject({
      status: "completed",
      threadId: body.threadId,
    });
  });

  it("continua um thread existente do mesmo cliente", async () => {
    const first = ChatResponseSchema.parse(
      (await post(A.keys.chat, { clientId: "cli-1", message: "olá" })).body,
    );
    const second = await post(A.keys.chat, {
      clientId: "cli-1",
      message: "e agora?",
      threadId: first.threadId,
    });
    expect(second.status).toBe(200);
    expect(ChatResponseSchema.parse(second.body).threadId).toBe(first.threadId);
  });

  describe("422 antes de reservar a cota (Review Focus 2)", () => {
    const invalid: [string, unknown][] = [
      ["8.001 caracteres", { clientId: "cli-1", message: "a".repeat(8001) }],
      ["só espaços", { clientId: "cli-1", message: "   \n\t " }],
      ["vazia", { clientId: "cli-1", message: "" }],
      ["sem corpo", undefined],
      ["clientId inválido", { clientId: "a b", message: "olá" }],
      ["threadId absurdo", { clientId: "cli-1", message: "olá", threadId: "t".repeat(300) }],
      // Mesmo contrato estrito do WebSocket: campo desconhecido não é ignorado em silêncio.
      ["campo desconhecido", { clientId: "cli-1", message: "olá", tenantId: "outro" }],
    ];
    for (const [name, body] of invalid) {
      it(name, async () => {
        await redis.set(quotaKey(A.tenantId), "7");
        const usage0 = await count("usage_record", A.tenantId);
        const res = await post(A.keys.chat, body);
        expect(res.status).toBe(422);
        expect(ProblemSchema.parse(res.body).status).toBe(422);
        expect(await count("usage_record", A.tenantId)).toBe(usage0);
        expect(await redis.get(quotaKey(A.tenantId))).toBe("7");
      });
    }
  });

  it("todos os provedores fora: 503 com Retry-After, cota devolvida, sem usage_record nem audit (Review Focus 4)", async () => {
    mocks.failing = true;
    await redis.set(quotaKey(A.tenantId), "3");
    const usage0 = await count("usage_record", A.tenantId);
    const audit0 = await count("audit_event", A.tenantId);
    const res = await post(A.keys.chat, { clientId: "cli-1", message: "olá" });
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    const problem = ProblemSchema.parse(res.body);
    expect(problem.type).toMatch(/all_providers_failed$/);
    expect(await redis.get(quotaKey(A.tenantId))).toBe("3");
    expect(await count("usage_record", A.tenantId)).toBe(usage0);
    expect(await count("audit_event", A.tenantId)).toBe(audit0);
  });

  it("threadId de outro cliente ou de outro tenant: 404 e a cota volta", async () => {
    const other = ChatResponseSchema.parse(
      (await post(A.keys.chat, { clientId: "cli-2", message: "olá" })).body,
    );
    const ofB = ChatResponseSchema.parse(
      (await post(B.keys.chat, { clientId: "cli-1", message: "olá" })).body,
    );
    await redis.set(quotaKey(A.tenantId), "5");
    const cli1 = await clientUuid(A.tenantId, "cli-1");
    for (const threadId of [
      other.threadId,
      ofB.threadId,
      `${B.tenantId}:${cli1}:x`,
      `${A.tenantId}:${cli1}`,
      "qualquer",
    ]) {
      const res = await post(A.keys.chat, { clientId: "cli-1", message: "olá", threadId });
      expect(res.status, threadId).toBe(404);
    }
    expect(await redis.get(quotaKey(A.tenantId))).toBe("5");
  });

  it("turno concorrente no mesmo thread: 409 thread_busy, sem rodar em paralelo, cota devolvida", async () => {
    const first = ChatResponseSchema.parse(
      (await post(A.keys.chat, { clientId: "cli-1", message: "olá" })).body,
    );
    // Outro turno em andamento segura o lock do thread.
    const held = must(await t.app.get(LockService).acquire(threadLockKey(first.threadId), 30_000));
    try {
      await redis.set(quotaKey(A.tenantId), "2");
      const usage0 = await count("usage_record", A.tenantId);
      const res = await post(A.keys.chat, {
        clientId: "cli-1",
        message: "olá",
        threadId: first.threadId,
      });
      expect(res.status).toBe(409);
      expect(ProblemSchema.parse(res.body).type).toMatch(/thread_busy$/);
      expect(await redis.get(quotaKey(A.tenantId))).toBe("2");
      expect(await count("usage_record", A.tenantId)).toBe(usage0);
    } finally {
      await held.release();
    }
    // Lock liberado: o turno seguinte passa.
    const next = await post(A.keys.chat, {
      clientId: "cli-1",
      message: "olá",
      threadId: first.threadId,
    });
    expect(next.status).toBe(200);
  });

  it("dois turnos simultâneos no mesmo thread: exatamente um passa e o outro recebe 409", async () => {
    const first = ChatResponseSchema.parse(
      (await post(A.keys.chat, { clientId: "cli-1", message: "olá" })).body,
    );
    const gate = gateOrchestrator(t);
    try {
      const p1 = post(A.keys.chat, {
        clientId: "cli-1",
        message: "olá",
        threadId: first.threadId,
      }).then((r) => r);
      await gate.reached;
      const r2 = await post(A.keys.chat, {
        clientId: "cli-1",
        message: "olá",
        threadId: first.threadId,
      });
      expect(r2.status).toBe(409);
      gate.release();
      expect((await p1).status).toBe(200);
    } finally {
      gate.release();
      gate.restore();
    }
  });

  it("cliente desconecta no meio do turno: o grafo termina em segundo plano, o lock é liberado e o turno é cobrado uma vez", async () => {
    const usage0 = await count("usage_record", A.tenantId);
    const gate = gateOrchestrator(t);
    try {
      const addr = (t.app.getHttpServer() as http.Server).address();
      if (!addr || typeof addr === "string") throw new Error("sem porta");
      const req = http.request({
        host: "127.0.0.1",
        port: addr.port,
        method: "POST",
        path: "/api/chat",
        headers: { authorization: `Bearer ${A.keys.chat}`, "content-type": "application/json" },
      });
      req.on("error", () => undefined);
      req.end(JSON.stringify({ clientId: "cli-1", message: "olá" }));
      await gate.reached;
      req.destroy(); // o cliente some antes do `done`
      await new Promise((r) => setTimeout(r, 50));
      gate.release();
      await eventually(
        async () => (await count("usage_record", A.tenantId)) === usage0 + 1,
        10_000,
        "cobrança",
      );
      await eventually(
        async () => (await redis.keys("chat:thread:*")).length === 0,
        10_000,
        "lock",
      );
      expect(await redis.get(quotaKey(A.tenantId))).toBe("1");
    } finally {
      gate.release();
      gate.restore();
    }
  });

  it("escopos: sem chave 401; chave sem chat 403", async () => {
    expect((await post(undefined, { clientId: "cli-1", message: "olá" })).status).toBe(401);
    expect((await post(A.keys.ingest, { clientId: "cli-1", message: "olá" })).status).toBe(403);
  });

  describe("POST /api/ws/ticket", () => {
    const ticket = (key: string | undefined, body: unknown) => {
      const r = request(server).post("/api/ws/ticket");
      return (key ? r.set("Authorization", `Bearer ${key}`) : r).send(body as object);
    };

    it("emite ticket opaco de uso único (30 s no Redis), ligado ao tenant, à chave e ao cliente", async () => {
      const res = await ticket(A.keys.chat, { clientId: "cli-1" });
      expect(res.status).toBe(201);
      const body = WsTicketSchema.parse(res.body);
      expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits em base64url
      expect(JSON.stringify(res.body)).not.toContain(A.keys.chat);
      const ttl = await redis.ttl(`ws:ticket:${body.ticket}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30);
      const stored = must(await redis.get(`ws:ticket:${body.ticket}`));
      expect(stored).not.toContain(A.keys.chat);
      expect(JSON.parse(stored)).toMatchObject({
        tenant: { tenantId: A.tenantId },
        client: { externalId: "cli-1" },
      });
      const second = WsTicketSchema.parse((await ticket(A.keys.chat, { clientId: "cli-1" })).body);
      expect(second.ticket).not.toBe(body.ticket);
    });

    it("consumo concorrente do mesmo ticket: exatamente uma conexão recebe o grant (GETDEL atômico)", async () => {
      const { ticket: tk } = WsTicketSchema.parse(
        (await ticket(A.keys.chat, { clientId: "cli-1" })).body,
      );
      const svc = t.app.get(WsTicketService);
      const grants = await Promise.all(Array.from({ length: 10 }, () => svc.consume(tk)));
      expect(grants.filter((g) => g !== null)).toHaveLength(1);
      expect(must(grants.find((g) => g !== null)).tenant.tenantId).toBe(A.tenantId);
      for (const bad of [undefined, 42, "", "x".repeat(43) + "=", "../../etc"]) {
        expect(await svc.consume(bad)).toBeNull();
      }
    });

    it("escopo chat obrigatório; corpo inválido 422", async () => {
      expect((await ticket(undefined, { clientId: "cli-1" })).status).toBe(401);
      expect((await ticket(A.keys.ingest, { clientId: "cli-1" })).status).toBe(403);
      expect((await ticket(A.keys.chat, {})).status).toBe(422);
      expect((await ticket(A.keys.chat, { clientId: "a b" })).status).toBe(422);
      expect((await ticket(A.keys.chat, { clientId: "c", tenantId: randomUUID() })).status).toBe(
        422,
      );
      expect(await redis.keys("ws:ticket:*")).toEqual([]);
    });
  });
});
