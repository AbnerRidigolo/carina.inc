/**
 * WebSocket do chat (`/ws/chat`), com o cliente `ws`: autenticação por ticket de uso único,
 * streaming dos eventos do turno, broadcast da inbox isolado por tenant e cliente, erros sem
 * detalhe interno, limites da conexão, cancelamento por desconexão e encerramento limpo.
 *
 * Todo socket aberto aqui é fechado (afterEach/afterAll): nenhum handle fica pendurado.
 */
import type http from "node:http";
import { type ChatEvent, ChatEventSchema, WsTicketSchema } from "@carina/shared";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import { ChatModule } from "../../src/modules/chat/chat.module.js";
import { CHAT_GATEWAY_OPTIONS } from "../../src/modules/chat/chat.gateway.js";
import { monthKey } from "../../src/modules/limits/month.js";
import { MockResponderRegistry } from "../../src/modules/llm/mock-models.js";
import { OrchestratorService } from "../../src/modules/orchestrator/orchestrator.service.js";
import { hashApiKey } from "../../src/modules/tenancy/api-key.js";
import { createTestApp, type SeededTenant, type TestApp } from "../setup/app.js";
import { migratorSql, must, redisDbUrl } from "../setup/db.js";
import { FailingMockRegistry, eventually, gateOrchestrator } from "./helpers.js";

// Outro DB lógico que o do chat.e2e (DB 1): os arquivos rodam em paralelo e cada um faz flush.
const REDIS_DB = 6;

/** Cliente de teste: guarda as mensagens recebidas e o fechamento. */
class TestSocket {
  readonly events: ChatEvent[] = [];
  readonly raw: string[] = [];
  closed: { code: number; reason: string } | undefined;
  private readonly closedP: Promise<{ code: number; reason: string }>;
  readonly opened: Promise<void>;

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data: Buffer) => {
      const text = data.toString();
      this.raw.push(text);
      this.events.push(ChatEventSchema.parse(JSON.parse(text)));
    });
    this.opened = new Promise((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    this.closedP = new Promise((resolve) =>
      ws.once("close", (code, reason) => {
        this.closed = { code, reason: reason.toString() };
        resolve(this.closed);
      }),
    );
    ws.on("error", () => undefined);
  }

  send(body: unknown): void {
    this.ws.send(typeof body === "string" ? body : JSON.stringify(body));
  }

  waitClose(timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    return Promise.race([
      this.closedP,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("socket não fechou")), timeoutMs).unref(),
      ),
    ]);
  }

  async waitFor(pred: (e: ChatEvent) => boolean, what = "evento"): Promise<ChatEvent> {
    await eventually(() => this.events.some(pred), 10_000, what);
    return must(this.events.find(pred));
  }

  of<T extends ChatEvent["type"]>(type: T): Extract<ChatEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<ChatEvent, { type: T }> => e.type === type);
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.terminate();
    }
  }
}

function portOf(t: TestApp): number {
  const addr = (t.app.getHttpServer() as http.Server).address();
  if (!addr || typeof addr === "string") throw new Error("servidor sem porta");
  return addr.port;
}

describe("Chat WebSocket", () => {
  let t: TestApp;
  let redis: Redis;
  let A: SeededTenant;
  let B: SeededTenant;
  const mocks = new FailingMockRegistry();
  const sockets: TestSocket[] = [];

  const ticketFor = async (key: string, clientId = "cli-1"): Promise<string> => {
    const res = await request(t.app.getHttpServer() as http.Server)
      .post("/api/ws/ticket")
      .set("Authorization", `Bearer ${key}`)
      .send({ clientId });
    expect(res.status).toBe(201);
    return WsTicketSchema.parse(res.body).ticket;
  };

  const open = (query = ""): TestSocket => {
    const s = new TestSocket(
      new WebSocket(`ws://127.0.0.1:${portOf(t)}/ws/chat${query}`, { autoPong: true }),
    );
    sockets.push(s);
    return s;
  };

  const connect = async (key: string, clientId = "cli-1"): Promise<TestSocket> => {
    const s = open(`?ticket=${await ticketFor(key, clientId)}`);
    await s.opened;
    return s;
  };

  /** Manda a mensagem e espera o `done` ou o `error` do turno (o n-ésimo, contando os anteriores). */
  const turn = async (s: TestSocket, body: unknown): Promise<ChatEvent[]> => {
    const before = s.events.length;
    const ends = () => s.events.filter((e) => e.type === "done" || e.type === "error").length;
    const endsBefore = ends();
    s.send(body);
    await eventually(() => ends() > endsBefore, 15_000, "fim do turno");
    return s.events.slice(before);
  };

  const quotaKey = (tenantId: string) => `quota:${tenantId}:${monthKey(Date.now())}`;
  const usageCount = async (tenantId: string) =>
    Number(
      must(
        (
          await migratorSql<{ n: string }>(`SELECT count(*)::text AS n FROM usage_record`, [], {
            tenantId,
          })
        )[0],
      ).n,
    );

  beforeAll(async () => {
    t = await createTestApp({
      imports: [ChatModule],
      redisDb: REDIS_DB,
      overrides: [{ token: MockResponderRegistry, useValue: mocks }],
    });
    redis = new Redis(redisDbUrl(REDIS_DB));
    A = await t.seedTenant({ name: "WS A", monthlyQuota: 1000 });
    B = await t.seedTenant({ name: "WS B", monthlyQuota: 1000 });
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await t?.close();
    await redis?.quit();
  });

  beforeEach(async () => {
    mocks.failing = false;
    await redis.flushdb();
  });

  afterEach(async () => {
    for (const s of sockets.splice(0)) {
      s.close();
      await s.waitClose().catch(() => undefined);
    }
  });

  describe("autenticação por ticket", () => {
    it("sem ticket: fecha com 4401 sem mandar nada", async () => {
      const s = open();
      expect((await s.waitClose()).code).toBe(4401);
      expect(s.raw).toEqual([]);
    });

    it("ticket inválido ou malformado: 4401", async () => {
      for (const q of ["?ticket=nao-existe", `?ticket=${"A".repeat(43)}`, "?ticket=", "?x=1"]) {
        const s = open(q);
        expect((await s.waitClose()).code, q).toBe(4401);
        expect(s.raw).toEqual([]);
      }
    });

    it("ticket reutilizado: a segunda conexão fecha com 4401 (GETDEL, uso único)", async () => {
      const ticket = await ticketFor(A.keys.chat);
      const first = open(`?ticket=${ticket}`);
      await first.opened;
      const second = open(`?ticket=${ticket}`);
      expect((await second.waitClose()).code).toBe(4401);
      // A primeira continua viva e atende.
      const events = await turn(first, { clientId: "cli-1", message: "olá" });
      expect(events.at(-1)?.type).toBe("done");
      expect(await redis.exists(`ws:ticket:${ticket}`)).toBe(0);
    });

    it("ticket vencido: 4401", async () => {
      const ticket = await ticketFor(A.keys.chat);
      await redis.pexpire(`ws:ticket:${ticket}`, 1);
      await new Promise((r) => setTimeout(r, 20));
      expect((await open(`?ticket=${ticket}`).waitClose()).code).toBe(4401);
    });

    it("mensagem mandada logo após o open (antes de o ticket ser conferido) não se perde", async () => {
      const s = open(`?ticket=${await ticketFor(A.keys.chat)}`);
      await s.opened;
      s.send({ clientId: "cli-1", message: "olá" });
      await s.waitFor((e) => e.type === "done", "done");
    });
  });

  it('"projeção da carteira": plan → agent_started → … → agent_result → done (canal ws)', async () => {
    const s = await connect(A.keys.chat);
    const events = await turn(s, { clientId: "cli-1", message: "projeção da carteira" });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("plan");
    expect(types.at(-1)).toBe("done");
    const started = types.indexOf("agent_started");
    const result = types.indexOf("agent_result");
    expect(started).toBeGreaterThan(0);
    expect(result).toBeGreaterThan(started);
    expect(events).toContainEqual({ type: "agent_started", agent: "predictor" });
    expect(events.some((e) => e.type === "agent_result" && e.agent === "predictor")).toBe(true);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("sem done");
    expect(done.status).toBe("completed");
    const plan = must(s.of("plan")[0]).plan;
    expect(plan.agents).toContain("predictor");
    expect(done.usage.workType).toBe(plan.agents.length > 1 ? "multi_agent_analysis" : "analysis");
    const [audit] = await migratorSql<{ channel: string }>(
      `SELECT channel FROM audit_event WHERE id = $1`,
      [done.compliance.auditId],
      { tenantId: A.tenantId },
    );
    expect(audit?.channel).toBe("ws");
  });

  it("erro do provedor no meio do stream: evento error com traceId, sem texto interno, cota devolvida e nada cobrado (Review Focus 4)", async () => {
    const s = await connect(A.keys.chat);
    await redis.set(quotaKey(A.tenantId), "4");
    const usage0 = await usageCount(A.tenantId);
    mocks.failing = true;
    const events = await turn(s, { clientId: "cli-1", message: "projeção da carteira" });
    expect(events[0]?.type).toBe("plan"); // falhou DEPOIS de o stream começar
    const last = events.at(-1);
    expect(last).toEqual({
      type: "error",
      code: "all_providers_failed",
      traceId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown as string,
    });
    expect(events.some((e) => e.type === "done")).toBe(false);
    const wire = s.raw.join("\n");
    for (const internal of ["provedores", "Error", "stack", "at "]) {
      expect(wire).not.toContain(internal);
    }
    expect(await redis.get(quotaKey(A.tenantId))).toBe("4");
    expect(await usageCount(A.tenantId)).toBe(usage0);
    // A conexão continua utilizável.
    mocks.failing = false;
    expect((await turn(s, { clientId: "cli-1", message: "olá" })).at(-1)?.type).toBe("done");
  });

  describe("broadcast da inbox", () => {
    interface Party {
      tenant: SeededTenant;
      socket: TestSocket;
      approvalId: string;
      threadId: string;
    }

    const buy = async (tenant: SeededTenant, clientId: string): Promise<Party> => {
      const socket = await connect(tenant.keys.chat, clientId);
      const events = await turn(socket, { clientId, message: "compre 100 ações de PETR4" });
      const done = events.at(-1);
      if (done?.type !== "done") throw new Error("compra sem done");
      expect(done.status).toBe("awaiting_approval");
      const approval = must(socket.of("approval_required")[0]).approval;
      return { tenant, socket, approvalId: approval.id, threadId: done.threadId };
    };

    /** Decide pela rota HTTP e retoma como o worker faria (WORKERS_ENABLED=false nos testes). */
    const approveAndExecute = async (p: Party) => {
      const res = await request(t.app.getHttpServer() as http.Server)
        .post(`/api/inbox/${p.approvalId}/decision`)
        .set("Authorization", `Bearer ${p.tenant.keys.approver}`)
        .send({ approved: true });
      expect(res.status).toBe(200);
      const [tid, cid] = p.threadId.split(":");
      await TenantContext.run({ tenantId: must(tid), clientId: must(cid) }, () =>
        t.app.get(OrchestratorService).resume(p.threadId, true),
      );
    };

    it("cada socket recebe só os eventos do próprio tenant e cliente (A, B e A/cli-2)", async () => {
      const a = await buy(A, "cli-1");
      const b = await buy(B, "cli-1");
      const a2 = await buy(A, "cli-2");

      await approveAndExecute(a);
      const executedA = await a.socket.waitFor((e) => e.type === "approval_executed", "executed A");
      expect(executedA).toMatchObject({
        type: "approval_executed",
        approvalId: a.approvalId,
        status: "succeeded",
      });
      await approveAndExecute(b);
      await b.socket.waitFor((e) => e.type === "approval_executed", "executed B");
      await approveAndExecute(a2);
      await a2.socket.waitFor((e) => e.type === "approval_executed", "executed A2");
      // Uma última volta em cada socket: tudo o que o broadcast tinha para entregar já chegou.
      for (const p of [a, b, a2]) {
        await turn(p.socket, { clientId: p === a2 ? "cli-2" : "cli-1", message: "olá" });
      }

      for (const p of [a, b, a2]) {
        const ids = p.socket.events.flatMap((e) =>
          e.type === "approval_required"
            ? [e.approval.id]
            : e.type === "approval_executed"
              ? [e.approvalId]
              : [],
        );
        expect(new Set(ids)).toEqual(new Set([p.approvalId]));
        // O approval_required do turno e o do broadcast (approval.created) chegam uma vez só.
        expect(p.socket.of("approval_required")).toHaveLength(1);
        expect(p.socket.of("approval_executed")).toHaveLength(1);
      }
    });

    it("evento forjado em inbox.events para o tenant do socket mas com aprovação de outro tenant não vaza", async () => {
      const b = await buy(B, "cli-1");
      const a = await connect(A.keys.chat);
      const aCli = must(
        (
          await migratorSql<{ id: string }>(
            `SELECT id FROM client WHERE external_id = 'cli-1'`,
            [],
            {
              tenantId: A.tenantId,
            },
          )
        )[0],
      ).id;
      // Evento com o tenant/cliente de A apontando para a aprovação de B: a busca sob o contexto de
      // A não a encontra (RLS) e nada é enviado.
      await redis.xadd(
        "inbox.events",
        "*",
        "data",
        JSON.stringify({
          eventId: crypto.randomUUID(),
          type: "approval.created",
          tenantId: A.tenantId,
          clientId: aCli,
          approvalId: b.approvalId,
        }),
      );
      await turn(a, { clientId: "cli-1", message: "olá" });
      await new Promise((r) => setTimeout(r, 200));
      expect(a.of("approval_required")).toEqual([]);
    });
  });

  describe("entrada não confiável", () => {
    it("JSON inválido, binário, tipo desconhecido e campos extras: error validation_error e a conexão segue", async () => {
      const s = await connect(A.keys.chat);
      const bad = ["{não é json", JSON.stringify({ type: "ping" }), JSON.stringify([1, 2])];
      for (const b of bad) {
        const events = await turn(s, b);
        expect(events.at(-1)).toMatchObject({ type: "error", code: "validation_error" });
      }
      const extra = await turn(s, { clientId: "cli-1", message: "olá", tenantId: B.tenantId });
      expect(extra.at(-1)).toMatchObject({ type: "error", code: "validation_error" });
      const long = await turn(s, { clientId: "cli-1", message: "a".repeat(8001) });
      expect(long.at(-1)).toMatchObject({ type: "error", code: "validation_error" });
      expect((await turn(s, { clientId: "cli-1", message: "olá" })).at(-1)?.type).toBe("done");
    });

    it("clientId diferente do ticket: error client_mismatch, nada cobrado", async () => {
      const s = await connect(A.keys.chat, "cli-1");
      await redis.set(quotaKey(A.tenantId), "9");
      const events = await turn(s, { clientId: "cli-2", message: "olá" });
      expect(events.at(-1)).toMatchObject({ type: "error", code: "client_mismatch" });
      expect(await redis.get(quotaKey(A.tenantId))).toBe("9");
    });

    it("mensagem acima do limite de bytes: fecha com 1009", async () => {
      const s = await connect(A.keys.chat);
      s.send({ clientId: "cli-1", message: "a".repeat(70_000) });
      expect((await s.waitClose()).code).toBe(1009);
    });

    it("segunda mensagem com um turno em andamento: error turn_in_progress (um turno por conexão)", async () => {
      const s = await connect(A.keys.chat);
      const gate = gateOrchestrator(t);
      try {
        s.send({ clientId: "cli-1", message: "olá" });
        await gate.reached;
        s.send({ clientId: "cli-1", message: "olá de novo" });
        await s.waitFor((e) => e.type === "error", "turn_in_progress");
        expect(s.of("error")[0]?.code).toBe("turn_in_progress");
        gate.release();
        await s.waitFor((e) => e.type === "done", "done");
      } finally {
        gate.release();
        gate.restore();
      }
    });

    it("limite por minuto do tenant vale por mensagem (mesma janela do REST)", async () => {
      const limited = await t.seedTenant({ name: "WS RPM", rpm: 2 });
      const s = await connect(limited.keys.chat); // o ticket gasta 1 da janela
      expect((await turn(s, { clientId: "cli-1", message: "olá" })).at(-1)?.type).toBe("done");
      const third = await turn(s, { clientId: "cli-1", message: "olá" });
      expect(third.at(-1)).toMatchObject({ type: "error", code: "rate_limited" });
    });
  });

  it("desconexão no meio de uma compra: o grafo termina em segundo plano (aprovação não fica órfã) e o lock é liberado", async () => {
    const s = await connect(A.keys.chat);
    const gate = gateOrchestrator(t);
    try {
      s.send({ clientId: "cli-1", message: "compre 100 ações de PETR4" });
      await gate.reached;
      await s.waitFor((e) => e.type === "plan", "plan");
      s.close(); // some no meio do turno
      await s.waitClose();
      gate.release();

      const rows = async () =>
        migratorSql<{ id: string; status: string; thread_id: string }>(
          `SELECT id, status, thread_id FROM approval_request WHERE created_at > now() - interval '1 minute'
             ORDER BY created_at DESC`,
          [],
          { tenantId: A.tenantId },
        );
      await eventually(async () => (await rows()).length > 0, 10_000, "aprovação gravada");
      await eventually(
        async () => (await redis.keys("chat:thread:*")).length === 0,
        10_000,
        "lock",
      );
      const row = must((await rows())[0]);
      expect(row.status).toBe("pending");
      // O checkpoint registra a espera: o thread está parado no nó approval com o `pending` salvo.
      const [tid, cid] = row.thread_id.split(":");
      const state = await TenantContext.run({ tenantId: must(tid), clientId: must(cid) }, () =>
        t.app.get(OrchestratorService).finalState(row.thread_id),
      );
      expect(state.pending?.approvalId).toBe(row.id);
    } finally {
      gate.release();
      gate.restore();
    }
  });
});

describe("Chat WebSocket: heartbeat, ociosidade e encerramento", () => {
  let t: TestApp;
  let A: SeededTenant;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    t = await createTestApp({
      imports: [ChatModule],
      redisDb: REDIS_DB,
      overrides: [
        { token: CHAT_GATEWAY_OPTIONS, useValue: { pingIntervalMs: 100, idleTimeoutMs: 400 } },
      ],
    });
    A = await t.seedTenant({ name: "WS HB" });
  });

  let closed = false;

  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    if (!closed) await t?.close();
  });

  const connect = async (autoPong: boolean): Promise<TestSocket> => {
    const res = await request(t.app.getHttpServer() as http.Server)
      .post("/api/ws/ticket")
      .set("Authorization", `Bearer ${A.keys.chat}`)
      .send({ clientId: "cli-1" });
    const ticket = WsTicketSchema.parse(res.body).ticket;
    const ws = new WebSocket(`ws://127.0.0.1:${portOf(t)}/ws/chat?ticket=${ticket}`, { autoPong });
    sockets.push(ws);
    const s = new TestSocket(ws);
    await s.opened;
    return s;
  };

  it("par que não responde ao ping é derrubado", async () => {
    const s = await connect(false);
    const closed = await s.waitClose(3000);
    expect(closed.code).toBe(1006); // terminate(): sem frame de close
  });

  it("conexão ociosa fecha com 4408", async () => {
    const s = await connect(true);
    expect((await s.waitClose(3000)).code).toBe(4408);
  });

  it("app.close() fecha os sockets abertos com 1001", async () => {
    const s = await connect(true);
    closed = true;
    await t.close();
    expect((await s.waitClose(3000)).code).toBe(1001);
  });
});

describe("Chat WebSocket: revalidação da chave e tempo máximo de vida", () => {
  let t: TestApp;
  let redis: Redis;
  const sockets: TestSocket[] = [];
  const MAX_LIFE_MS = 1000;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [ChatModule],
      redisDb: REDIS_DB,
      // Sem cache na revalidação (efeito imediato) e vida curta; heartbeat curto para a checagem.
      env: { API_KEY_REVALIDATE_TTL_MS: "0", WS_MAX_CONNECTION_MS: String(MAX_LIFE_MS) },
      overrides: [{ token: CHAT_GATEWAY_OPTIONS, useValue: { pingIntervalMs: 100 } }],
    });
    redis = new Redis(redisDbUrl(REDIS_DB));
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await t?.close();
    await redis?.quit();
  });

  afterEach(async () => {
    for (const s of sockets.splice(0)) {
      s.close();
      await s.waitClose().catch(() => undefined);
    }
  });

  const connect = async (key: string): Promise<TestSocket> => {
    const res = await request(t.app.getHttpServer() as http.Server)
      .post("/api/ws/ticket")
      .set("Authorization", `Bearer ${key}`)
      .send({ clientId: "cli-1" });
    expect(res.status).toBe(201);
    const ticket = WsTicketSchema.parse(res.body).ticket;
    const s = new TestSocket(
      new WebSocket(`ws://127.0.0.1:${portOf(t)}/ws/chat?ticket=${ticket}`, { autoPong: true }),
    );
    sockets.push(s);
    await s.opened;
    return s;
  };

  const usageCount = async (tenantId: string) =>
    Number(
      must(
        (
          await migratorSql<{ n: string }>(`SELECT count(*)::text AS n FROM usage_record`, [], {
            tenantId,
          })
        )[0],
      ).n,
    );

  /** Turno recusado pela revalidação: error unauthenticated, 4401, nada cobrado nem reservado. */
  const expectRefused = async (tenant: SeededTenant, s: TestSocket) => {
    const quotaKey = `quota:${tenant.tenantId}:${monthKey(Date.now())}`;
    await redis.set(quotaKey, "3");
    const usage0 = await usageCount(tenant.tenantId);
    s.send({ clientId: "cli-1", message: "olá" });
    const closed = await s.waitClose();
    expect(closed.code).toBe(4401);
    expect(s.events.map((e) => e.type)).toEqual(["error"]);
    expect(s.of("error")[0]?.code).toBe("unauthenticated");
    expect(await usageCount(tenant.tenantId)).toBe(usage0);
    expect(await redis.get(quotaKey)).toBe("3");
  };

  it("chave revogada com o socket aberto: o próximo turno é recusado e o socket fecha com 4401", async () => {
    const tenant = await t.seedTenant({ name: "Rev", monthlyQuota: 100 });
    const s = await connect(tenant.keys.chat);
    await t.revokeKey(tenant.keys.chat);
    await expectRefused(tenant, s);
  });

  it("escopo chat removido da chave: mesmo resultado", async () => {
    const tenant = await t.seedTenant({ name: "Scope", monthlyQuota: 100 });
    const s = await connect(tenant.keys.chat);
    await migratorSql(`UPDATE api_key SET scopes = '{inbox:decide}' WHERE hash = $1`, [
      hashApiKey(tenant.keys.chat),
    ]);
    await expectRefused(tenant, s);
  });

  it("tenant suspenso: mesmo resultado, e o REST também recusa (401)", async () => {
    const tenant = await t.seedTenant({ name: "Susp", monthlyQuota: 100 });
    const s = await connect(tenant.keys.chat);
    await migratorSql(`UPDATE tenant SET suspended_at = now() WHERE id = $1`, [tenant.tenantId]);
    await expectRefused(tenant, s);
    const rest = await request(t.app.getHttpServer() as http.Server)
      .post("/api/chat")
      .set("Authorization", `Bearer ${tenant.keys.chat}`)
      .send({ clientId: "cli-1", message: "olá" });
    expect(rest.status).toBe(401);
  });

  it("rpm e cota vêm do tenant vivo, não do retrato do ticket", async () => {
    const tenant = await t.seedTenant({ name: "Plano", rpm: 1000, monthlyQuota: 100 });
    const s = await connect(tenant.keys.chat); // o ticket gasta 1 da janela
    // Plano reduzido depois da emissão do ticket: rpm 1 (a janela já tem 1) → rate_limited.
    await migratorSql(`UPDATE tenant SET rpm = 1 WHERE id = $1`, [tenant.tenantId]);
    s.send({ clientId: "cli-1", message: "olá" });
    await s.waitFor((e) => e.type === "error", "rate_limited");
    expect(s.of("error")[0]?.code).toBe("rate_limited");
    // Cota mensal reduzida abaixo do já usado → quota_exceeded.
    await migratorSql(`UPDATE tenant SET rpm = 1000, monthly_quota = 2 WHERE id = $1`, [
      tenant.tenantId,
    ]);
    await redis.set(`quota:${tenant.tenantId}:${monthKey(Date.now())}`, "5");
    s.send({ clientId: "cli-1", message: "olá" });
    await eventually(() => s.of("error").length === 2, 10_000, "quota_exceeded");
    expect(s.of("error")[1]?.code).toBe("quota_exceeded");
  });

  it("o tempo máximo de vida fecha a conexão com 4401, e um ticket novo funciona", async () => {
    const tenant = await t.seedTenant({ name: "Vida" });
    const s = await connect(tenant.keys.chat);
    const started = Date.now();
    const closed = await s.waitClose(5000);
    expect(closed.code).toBe(4401);
    expect(Date.now() - started).toBeGreaterThanOrEqual(MAX_LIFE_MS - 50);
    const again = await connect(tenant.keys.chat);
    again.send({ clientId: "cli-1", message: "olá" });
    await again.waitFor((e) => e.type === "done", "done no socket novo");
  });

  it("um turno em andamento termina antes de o socket fechar por tempo de vida", async () => {
    const tenant = await t.seedTenant({ name: "Vida turno" });
    const s = await connect(tenant.keys.chat);
    const gate = gateOrchestrator(t);
    try {
      s.send({ clientId: "cli-1", message: "olá" });
      await gate.reached;
      await new Promise((r) => setTimeout(r, MAX_LIFE_MS + 300)); // a vida venceu no meio do turno
      expect(s.closed).toBeUndefined();
      gate.release();
      await s.waitFor((e) => e.type === "done", "done");
      expect((await s.waitClose(3000)).code).toBe(4401);
      expect(s.events.at(-1)?.type).toBe("done");
    } finally {
      gate.release();
      gate.restore();
    }
  });
});
