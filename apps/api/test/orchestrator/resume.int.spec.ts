/**
 * Worker de retomada (Task 19) com Nest, Postgres e Redis reais, em LLM_MODE=mock: a decisão da
 * inbox publica `resume` em `jobs` e o ResumeWorker (grupo `resumers`) retoma o grafo; a execução
 * acontece no máximo uma vez mesmo com reentrega, eventos duplicados e dois consumidores; eventos
 * forjados não executam nada; a expiração pela reconciliação destrava o thread.
 *
 * Redis: DB lógico próprio (test/setup/redis-dbs.ts), esvaziado a cada teste. Os testes de reentrega usam consumidores próprios
 * (StreamsService com reivindicação rápida) chamando `ResumeWorker.handle`; o loop real do worker
 * só liga onde o teste pede (`workersEnabled: true`).
 */
import { randomUUID } from "node:crypto";
import type { ChatEvent, StreamEvent } from "@carina/shared";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import { ApprovalConflictError } from "../../src/core/errors/domain-errors.js";
import { StreamsService } from "../../src/core/redis/streams.service.js";
import { ExecutorRegistry } from "../../src/modules/inbox/executors.js";
import { InboxService } from "../../src/modules/inbox/inbox.service.js";
import { KnowledgeService } from "../../src/modules/knowledge/knowledge.service.js";
import { ReconciliationJob } from "../../src/modules/inbox/reconciliation.job.js";
import { CLOCK } from "../../src/modules/limits/clock.js";
import { OrchestratorModule } from "../../src/modules/orchestrator/orchestrator.module.js";
import { OrchestratorService } from "../../src/modules/orchestrator/orchestrator.service.js";
import {
  RESUME_GROUP,
  RESUME_LOGGER,
  ResumeWorker,
} from "../../src/modules/orchestrator/resume.worker.js";
import { deferred } from "../chat/helpers.js";
import { createTestApp, type TestApp } from "../setup/app.js";
import { appUrl, migratorSql, must, redisDbUrl, withPgClient } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

const REDIS_DB = redisDbOf("orchestrator/resume.int.spec.ts");
const HOUR = 3_600_000;

interface Party {
  tenantId: string;
  clientId: string;
  by: Parameters<InboxService["decide"]>[2];
}

type Resume = Extract<StreamEvent, { type: "resume" }>;

async function until(cond: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout de ${ms} ms aguardando condição`);
}

describe("ResumeWorker (int)", () => {
  let redis: Redis;
  const apps: TestApp[] = [];
  let offset = 0;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const silent = { error: vi.fn(), warn: vi.fn() };
  const placeTrade = vi.fn(async () => ({ orderId: "SIM-RESUME", status: "filled" }));
  const stops: (() => Promise<void>)[] = [];

  async function start(workersEnabled = false): Promise<TestApp> {
    const t = await createTestApp({
      imports: [OrchestratorModule],
      redisDb: REDIS_DB,
      workersEnabled,
      overrides: [
        { token: CLOCK, useValue: () => Date.now() + offset },
        { token: RESUME_LOGGER, useValue: logger },
      ],
    });
    t.app.get(ExecutorRegistry).register("place_trade", placeTrade);
    apps.push(t);
    return t;
  }

  async function party(t: TestApp, name: string): Promise<Party> {
    const seeded = await t.seedTenant({ name });
    const [c] = await migratorSql<{ id: string }>(
      `INSERT INTO client (tenant_id, external_id) VALUES ($1, 'cli-1') RETURNING id`,
      [seeded.tenantId],
      { tenantId: seeded.tenantId },
    );
    const [k] = await migratorSql<{ id: string }>(
      `SELECT id FROM api_key WHERE tenant_id = $1 AND label = 'approver'`,
      [seeded.tenantId],
    );
    return {
      tenantId: seeded.tenantId,
      clientId: must(c).id,
      by: {
        keyId: must(k).id,
        tenantId: seeded.tenantId,
        tenantName: name,
        scopes: ["chat", "inbox:decide"],
        rpm: 1000,
        monthlyQuota: 0,
      },
    };
  }

  const as = <R>(p: Party, fn: () => Promise<R>) =>
    TenantContext.run({ tenantId: p.tenantId, clientId: p.clientId }, fn);
  const newThread = (p: Party) => `${p.tenantId}:${p.clientId}:${randomUUID()}`;

  async function turn(t: TestApp, p: Party, threadId: string, question: string) {
    const events: ChatEvent[] = [];
    await as(p, async () => {
      for await (const e of t.app.get(OrchestratorService).stream({ threadId, question })) {
        events.push(e);
      }
    });
    return events;
  }

  /** Conversa pausada à espera de aprovação (como na Task 18); devolve thread e aprovação. */
  async function paused(t: TestApp, p: Party, question = "compre 100 ações de PETR4") {
    const threadId = newThread(p);
    const events = await turn(t, p, threadId, question);
    const last = events.at(-1);
    if (last?.type !== "approval_required") throw new Error("esperava approval_required");
    return { threadId, approvalId: last.approval.id };
  }

  const decide = (t: TestApp, p: Party, id: string, approved: boolean) =>
    TenantContext.run({ tenantId: p.tenantId }, () =>
      t.app.get(InboxService).decide(id, { approved }, p.by),
    );

  const execution = async (p: Party, approvalId: string) =>
    (
      await migratorSql<{ status: string }>(
        `SELECT status FROM executed_action WHERE approval_request_id = $1`,
        [approvalId],
        { tenantId: p.tenantId },
      )
    )[0];
  const approvalStatus = async (p: Party, approvalId: string) =>
    (
      await migratorSql<{ status: string }>(
        `SELECT status FROM approval_request WHERE id = $1`,
        [approvalId],
        { tenantId: p.tenantId },
      )
    )[0]?.status;
  const usage = (p: Party) =>
    migratorSql<{ fee_brl: string }>(
      `SELECT fee_brl::text AS fee_brl FROM usage_record WHERE work_type = 'execution'`,
      [],
      { tenantId: p.tenantId },
    );

  async function streamEvents(stream: string): Promise<StreamEvent[]> {
    const rows = await redis.xrange(stream, "-", "+");
    return rows.map(([, f]) => JSON.parse(f[1] as string) as StreamEvent);
  }
  const resumesOf = async (p: Party) =>
    (await streamEvents("jobs")).filter(
      (e): e is Resume => e.type === "resume" && e.tenantId === p.tenantId,
    );
  const pendingResumers = async () => {
    try {
      return ((await redis.xpending("jobs", RESUME_GROUP)) as [number, ...unknown[]])[0];
    } catch {
      return -1;
    }
  };

  /**
   * Consumidor próprio do grupo `resumers` (StreamsService com reentrega rápida) que delega ao
   * `handle` de um ResumeWorker; `only` restringe aos eventos deste teste (o banco é compartilhado
   * com outros arquivos e a reconciliação varre todos os tenants): os demais recebem só ACK.
   */
  function consumer(
    worker: ResumeWorker,
    name: string,
    opts: { only?: Party; maxDeliveries?: number; claimIdleMs?: number } = {},
  ) {
    const conn = new Redis(redisDbUrl(REDIS_DB));
    const streams = new StreamsService(conn, {
      claimIdleMs: opts.claimIdleMs ?? 150,
      blockMs: 100,
      maxDeliveries: opts.maxDeliveries ?? 5,
      logger: silent,
    });
    const ac = new AbortController();
    const calls = { n: 0 };
    const done = streams.consume({
      stream: "jobs",
      group: RESUME_GROUP,
      consumer: name,
      handler: async (e) => {
        if (opts.only && e.tenantId !== opts.only.tenantId) return;
        calls.n++;
        await worker.handle(e);
      },
      signal: ac.signal,
    });
    const stop = async () => {
      ac.abort();
      await done;
      conn.disconnect();
    };
    stops.push(stop);
    return { calls, stop };
  }

  beforeAll(() => {
    redis = new Redis(redisDbUrl(REDIS_DB));
  });

  afterAll(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  beforeEach(async () => {
    await redis.flushdb();
    offset = 0;
    placeTrade.mockClear();
    for (const f of [logger.info, logger.warn, logger.error, silent.error, silent.warn]) {
      f.mockClear();
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    while (stops.length) await stops.pop()?.();
    while (apps.length) await apps.pop()?.close();
  });

  it("decide(approved) → worker executa: succeeded, cobrança de R$ 15,00 e approval.executed", async () => {
    const t = await start(true);
    expect(t.app.get(ResumeWorker).running).toBe(true);
    const A = await party(t, "Resume A");
    const { threadId, approvalId } = await paused(t, A);
    expect(placeTrade).not.toHaveBeenCalled();

    await decide(t, A, approvalId, true);

    await until(async () => (await execution(A, approvalId))?.status === "succeeded");
    expect(placeTrade).toHaveBeenCalledTimes(1);
    expect(await usage(A)).toEqual([{ fee_brl: "15.00" }]);
    await until(async () =>
      (await streamEvents("inbox.events")).some(
        (e) => e.type === "approval.executed" && e.approvalId === approvalId,
      ),
    );
    const executed = (await streamEvents("inbox.events")).filter(
      (e) => e.type === "approval.executed",
    );
    expect(executed).toEqual([expect.objectContaining({ approvalId, status: "succeeded" })]);
    await until(async () => (await pendingResumers()) === 0);
    const state = await as(A, () => t.app.get(OrchestratorService).finalState(threadId));
    expect(state.execution?.status).toBe("succeeded");

    // Um segundo resume para a mesma aprovação (ex.: republicado) não cobra de novo.
    const [first] = await resumesOf(A);
    await t.app.get(StreamsService).publish("jobs", { ...must(first), eventId: randomUUID() });
    await until(async () => (await redis.xlen("jobs")) === 2 && (await pendingResumers()) === 0);
    await until(() => logger.info.mock.calls.length >= 2);
    expect(placeTrade).toHaveBeenCalledTimes(1);
    expect(await usage(A)).toEqual([{ fee_brl: "15.00" }]);
    expect(
      (await streamEvents("inbox.events")).filter((e) => e.type === "approval.executed"),
    ).toHaveLength(1);
    expect(await redis.xlen("jobs.dlq").catch(() => 0)).toBe(0);
  });

  it("mesmo resume entregue duas vezes e por dois consumidores (dois workers): executa uma vez", async () => {
    const t1 = await start();
    const t2 = await start();
    const A = await party(t1, "Resume dup");
    const { approvalId } = await paused(t1, A);
    // Executor lento: a entrada fica ociosa além do claimIdleMs e o outro consumidor a reivindica
    // enquanto o primeiro ainda executa (retomadas concorrentes de verdade).
    placeTrade.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 400));
      return { orderId: "SIM-RESUME", status: "filled" };
    });
    await decide(t1, A, approvalId, true);
    const [original] = await resumesOf(A);
    const fields = ["data", JSON.stringify(must(original))];
    // Mesma entrada (mesmo eventId) de novo, e o mesmo resume com outro eventId (republicação).
    await redis.xadd("jobs", "*", ...fields);
    await redis.xadd("jobs", "*", "data", JSON.stringify({ ...original, eventId: randomUUID() }));

    const c1 = consumer(t1.app.get(ResumeWorker), "w1", { only: A });
    const c2 = consumer(t2.app.get(ResumeWorker), "w2", { only: A });
    await until(async () => (await execution(A, approvalId))?.status === "succeeded");
    await until(async () => (await pendingResumers()) === 0);
    await c1.stop();
    await c2.stop();

    // Original + republicado + ao menos uma reivindicação da entrada ainda em andamento.
    expect(c1.calls.n + c2.calls.n).toBeGreaterThanOrEqual(3);
    expect(placeTrade).toHaveBeenCalledTimes(1);
    expect(await usage(A)).toEqual([{ fee_brl: "15.00" }]);
    expect(
      (await streamEvents("inbox.events")).filter(
        (e) => e.type === "approval.executed" && e.approvalId === approvalId,
      ),
    ).toHaveLength(1);
    expect(await redis.exists("jobs.dlq")).toBe(0);
  });

  it("eventos forjados ou venenosos não derrubam o loop nem executam nada", async () => {
    const t = await start(true);
    const A = await party(t, "Resume vítima");
    const B = await party(t, "Resume atacante");
    const victim = await paused(t, A);
    // Aprovada no banco, mas o resume legítimo é descartado: só os forjados chegam ao worker.
    await decide(t, A, victim.approvalId, true);
    await until(async () => (await execution(A, victim.approvalId))?.status === "succeeded");
    placeTrade.mockClear();
    const other = await paused(t, A, "compre 10 ações de VALE3");
    await TenantContext.run({ tenantId: A.tenantId }, async () => {
      // decide grava approved e publica resume; o worker real o consumiria, então paramos antes
      await t.app.get(ResumeWorker).stop();
      await t.app.get(InboxService).decide(other.approvalId, { approved: true }, A.by);
    });
    await redis.del("jobs");
    t.app.get(ResumeWorker).start();

    const streams = t.app.get(StreamsService);
    const base = { type: "resume" as const, approved: true, approvalId: other.approvalId };
    // 1. formato inválido (JSON quebrado e schema errado): DLQ pelo StreamsService
    await redis.xadd("jobs", "*", "data", "{nao é json");
    await redis.xadd("jobs", "*", "data", JSON.stringify({ type: "resume", eventId: "x" }));
    // 2. tenant/cliente do atacante com o thread da vítima
    await streams.publish("jobs", {
      ...base,
      eventId: randomUUID(),
      tenantId: B.tenantId,
      clientId: B.clientId,
      threadId: other.threadId,
    });
    // 3. ids da vítima no evento, mas thread de outro tenant (não confere)
    await streams.publish("jobs", {
      ...base,
      eventId: randomUUID(),
      tenantId: A.tenantId,
      clientId: A.clientId,
      threadId: `${B.tenantId}:${B.clientId}:${other.threadId.split(":")[2] ?? "x"}`,
    });
    // 4. thread desconhecido do próprio tenant
    await streams.publish("jobs", {
      ...base,
      eventId: randomUUID(),
      tenantId: A.tenantId,
      clientId: A.clientId,
      threadId: newThread(A),
    });
    // 5. thread certo, mas com o approvalId de outra aprovação (já resolvida)
    await streams.publish("jobs", {
      ...base,
      eventId: randomUUID(),
      tenantId: A.tenantId,
      clientId: A.clientId,
      threadId: other.threadId,
      approvalId: victim.approvalId,
    });
    await until(async () => (await pendingResumers()) === 0 && (await redis.xlen("jobs")) === 6);
    await until(async () => logger.error.mock.calls.length + logger.warn.mock.calls.length >= 4);
    expect(placeTrade).not.toHaveBeenCalled();
    expect(await execution(A, other.approvalId)).toBeUndefined();
    expect(await redis.xlen("jobs.dlq")).toBe(2);
    expect(logger.error).toHaveBeenCalledTimes(2); // os dois de ids que não conferem
    for (const [fields] of [...logger.error.mock.calls, ...logger.warn.mock.calls] as [
      Record<string, unknown>,
    ][]) {
      expect(
        Object.keys(fields).every((k) =>
          ["msg", "err", "eventId", "tenantId", "clientId", "approvalId", "threadId"].includes(k),
        ),
      ).toBe(true);
    }

    // O loop segue vivo: o resume legítimo, depois de tudo isso, executa.
    await streams.publish("jobs", {
      ...base,
      eventId: randomUUID(),
      tenantId: A.tenantId,
      clientId: A.clientId,
      threadId: other.threadId,
    });
    await until(async () => (await execution(A, other.approvalId))?.status === "succeeded");
    expect(placeTrade).toHaveBeenCalledTimes(1);
  });

  it("aprovação ainda pending no banco: retenta pela reentrega até a DLQ, sem executar", async () => {
    const t = await start();
    const A = await party(t, "Resume cedo");
    const { threadId, approvalId } = await paused(t, A);
    await t.app.get(StreamsService).publish("jobs", {
      eventId: randomUUID(),
      type: "resume",
      tenantId: A.tenantId,
      clientId: A.clientId,
      approvalId,
      threadId,
      approved: true,
    });
    const c = consumer(t.app.get(ResumeWorker), "w1", { maxDeliveries: 3, claimIdleMs: 100 });
    await until(async () => (await redis.exists("jobs.dlq")) === 1);
    await c.stop();
    expect(c.calls.n).toBe(3);
    expect(placeTrade).not.toHaveBeenCalled();
    expect(await approvalStatus(A, approvalId)).toBe("pending");
    expect(await execution(A, approvalId)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(3);

    // O thread continua retomável: depois da decisão, o resume dela executa uma vez.
    await decide(t, A, approvalId, true);
    const c2 = consumer(t.app.get(ResumeWorker), "w2");
    await until(async () => (await execution(A, approvalId))?.status === "succeeded");
    await c2.stop();
    expect(placeTrade).toHaveBeenCalledTimes(1);
  });

  it("erro transitório no orquestrador: sem ACK, reentregue e executado uma vez", async () => {
    const t = await start();
    const A = await party(t, "Resume transitório");
    const { approvalId } = await paused(t, A);
    const orchestrator = t.app.get(OrchestratorService);
    const real = orchestrator.resume.bind(orchestrator);
    vi.spyOn(orchestrator, "resume")
      .mockRejectedValueOnce(new Error("conexão perdida"))
      .mockImplementation(real);
    await decide(t, A, approvalId, true);
    const c = consumer(t.app.get(ResumeWorker), "w1");
    await until(async () => (await execution(A, approvalId))?.status === "succeeded");
    await until(async () => (await pendingResumers()) === 0);
    await c.stop();
    expect(c.calls.n).toBe(2);
    expect(placeTrade).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), approvalId }),
    );
    expect(await redis.exists("jobs.dlq")).toBe(0);
  });

  it("thread desconhecido (NotFound) é terminal: uma entrega só, ACK, sem DLQ", async () => {
    const t = await start();
    const A = await party(t, "Resume sem thread");
    await t.app.get(StreamsService).publish("jobs", {
      eventId: randomUUID(),
      type: "resume",
      tenantId: A.tenantId,
      clientId: A.clientId,
      approvalId: "c".repeat(64),
      threadId: newThread(A),
      approved: true,
    });
    const c = consumer(t.app.get(ResumeWorker), "w1", { claimIdleMs: 100 });
    await until(async () => c.calls.n === 1 && (await pendingResumers()) === 0);
    await new Promise((r) => setTimeout(r, 400)); // nenhuma reentrega depois do ACK
    await c.stop();
    expect(c.calls.n).toBe(1);
    expect(await redis.exists("jobs.dlq")).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("expiração pela reconciliação (CLOCK adiantado) → worker grava rejected e destrava o thread", async () => {
    const t = await start();
    const A = await party(t, "Resume vencida");
    const { threadId, approvalId } = await paused(t, A);
    // Tick restrito ao tenant deste teste: o banco é compartilhado com arquivos em paralelo.
    offset = 25 * HOUR; // APPROVAL_TTL_HOURS = 24
    await t.app.get(ReconciliationJob).run({ onlyTenants: [A.tenantId] });
    expect(await approvalStatus(A, approvalId)).toBe("expired");
    expect(await resumesOf(A)).toEqual([
      expect.objectContaining({ approvalId, threadId, approved: false }),
    ]);

    const c = consumer(t.app.get(ResumeWorker), "w1", { only: A });
    const svc = t.app.get(OrchestratorService);
    await until(async () => (await as(A, () => svc.finalState(threadId))).execution !== null);
    await until(async () => (await pendingResumers()) === 0);
    await c.stop();

    const state = await as(A, () => svc.finalState(threadId));
    expect(state.execution).toEqual({ approvalId, status: "rejected" });
    expect(placeTrade).not.toHaveBeenCalled();
    expect(await execution(A, approvalId)).toBeUndefined();
    expect(await approvalStatus(A, approvalId)).toBe("expired");

    // Thread destravado: um novo turno roda (sem ApprovalConflictError).
    const events = await turn(t, A, threadId, "qual o saldo da minha carteira?");
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "approval_required")).toBe(false);
  });

  it("WORKERS_ENABLED=false não consome; o encerramento espera a mensagem em andamento", async () => {
    const off = await start(false);
    expect(off.app.get(ResumeWorker).running).toBe(false);
    const groups = async () =>
      ((await redis.xinfo("GROUPS", "jobs").catch(() => [])) as unknown[][]).map((g) => g[1]);
    await new Promise((r) => setTimeout(r, 200));
    expect(await groups()).toEqual([]);

    const t = await start(true);
    const A = await party(t, "Resume shutdown");
    const { approvalId } = await paused(t, A);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    placeTrade.mockImplementation(async () => {
      entered = true;
      await gate;
      return { orderId: "SIM-RESUME", status: "filled" };
    });
    await decide(t, A, approvalId, true);
    await until(() => entered);
    expect(await groups()).toEqual([RESUME_GROUP]);

    const worker = t.app.get(ResumeWorker);
    let closed = false;
    const closing = t.close().then(() => {
      closed = true;
    });
    apps.splice(apps.indexOf(t), 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(closed).toBe(false); // o encerramento espera a mensagem em andamento
    expect(await execution(A, approvalId)).toEqual({ status: "started" });
    release();
    const began = Date.now();
    await closing;
    expect(Date.now() - began).toBeLessThan(3000);
    expect(worker.running).toBe(false);
    // A mensagem em andamento terminou (e foi confirmada) antes de o app fechar.
    expect(await execution(A, approvalId)).toEqual({ status: "succeeded" });
    expect(await pendingResumers()).toBe(0);
    expect(placeTrade).toHaveBeenCalledTimes(1);
  });

  describe("aprovação aprovada órfã (o thread nunca esperou por ela)", () => {
    /** Aprovação gravada sem o `pending` do checkpoint (ex.: o turno caiu depois do request). */
    async function orphan(t: TestApp, p: Party) {
      const threadId = newThread(p);
      const { approvalId } = await as(p, () =>
        t.app.get(InboxService).request({
          threadId,
          turn: 1,
          agent: "executor",
          action: "place_trade",
          payload: { side: "buy", assetCode: "PETR4", quantity: 100 },
          valueBrl: "3000.00",
        }),
      );
      await decide(t, p, approvalId, true);
      await redis.del("jobs");
      return { threadId, approvalId };
    }
    const resumeEvent = (p: Party, threadId: string, approvalId: string): Resume => ({
      type: "resume",
      eventId: randomUUID(),
      tenantId: p.tenantId,
      clientId: p.clientId,
      threadId,
      approvalId,
      approved: true,
    });
    const audits = (p: Party) =>
      migratorSql<{ query: string; channel: string }>(
        `SELECT query, channel FROM audit_event WHERE query LIKE 'orphan:%'`,
        [],
        { tenantId: p.tenantId },
      );
    const activeTenants = () =>
      withPgClient(appUrl(), async (c) =>
        (await c.query<{ id: string }>("SELECT active_tenant_ids() AS id")).rows.map((r) => r.id),
      );

    it("worker: passada a carência, fecha como needs_review e audita; nada executa, a reconciliação para e o tenant sai da varredura", async () => {
      const t = await start();
      const A = await party(t, "Órfã worker");
      const { threadId, approvalId } = await orphan(t, A);
      const worker = t.app.get(ResumeWorker);

      // Recém-decidida: pode ser só o checkpoint ainda não gravado. ACK sem fechar.
      await worker.handle(resumeEvent(A, threadId, approvalId));
      expect(await execution(A, approvalId)).toBeUndefined();

      offset = 3 * 60_000; // passou a carência de 2 min
      await worker.handle(resumeEvent(A, threadId, approvalId));
      expect(await execution(A, approvalId)).toEqual({ status: "needs_review" });
      expect(await audits(A)).toEqual([{ query: "orphan:place_trade", channel: "worker" }]);
      expect(placeTrade).not.toHaveBeenCalled();

      // A reconciliação não republica mais e o tenant deixa de aparecer na varredura.
      await t.app.get(ReconciliationJob).run({ onlyTenants: [A.tenantId] });
      expect(await resumesOf(A)).toEqual([]);
      expect(await activeTenants()).not.toContain(A.tenantId);
      // Reentrega posterior: idempotente (sem segunda auditoria, sem execução).
      await worker.handle(resumeEvent(A, threadId, approvalId));
      expect(await audits(A)).toHaveLength(1);
      expect(placeTrade).not.toHaveBeenCalled();
    });

    it("evento com thread que não é o da aprovação não fecha nada", async () => {
      const t = await start();
      const A = await party(t, "Órfã thread errado");
      const { approvalId } = await orphan(t, A);
      offset = 3 * 60_000;
      await t.app.get(ResumeWorker).handle(resumeEvent(A, newThread(A), approvalId));
      expect(await execution(A, approvalId)).toBeUndefined();
      expect(await audits(A)).toEqual([]);
    });

    it("reconciliação: aprovada sem execução além da janela de republicação vira needs_review (sem laço infinito)", async () => {
      const t = await start();
      const A = await party(t, "Órfã janela");
      const { approvalId } = await orphan(t, A);
      const job = t.app.get(ReconciliationJob);

      offset = 3 * 60_000; // dentro da janela: republica
      await job.run({ onlyTenants: [A.tenantId] });
      expect((await resumesOf(A)).map((e) => e.approvalId)).toEqual([approvalId]);
      await redis.del("jobs");

      offset = 2 * HOUR; // além da janela: fecha em vez de republicar
      await job.run({ onlyTenants: [A.tenantId] });
      expect(await resumesOf(A)).toEqual([]);
      expect(await execution(A, approvalId)).toEqual({ status: "needs_review" });
      expect(await audits(A)).toHaveLength(1);
      expect(await activeTenants()).not.toContain(A.tenantId);
      expect(placeTrade).not.toHaveBeenCalled();
    });
  });

  describe("resume perdido (ex.: foi para a DLQ): o guard do stream cura o thread", () => {
    /** Thread pausado cujo `resume` nunca chega ao worker (o stream é esvaziado). */
    async function lost(t: TestApp, p: Party) {
      const paused1 = await paused(t, p);
      await redis.del("jobs");
      return paused1;
    }

    const awaiting = async (t: TestApp, p: Party, threadId: string) => {
      const state = await as(p, () => t.app.get(OrchestratorService).finalState(threadId));
      return state.pending !== null && state.execution === null;
    };

    /**
     * A cura do guard (`closeResolvedWait`) chamada como o turno que leu o estado ANTES de outro
     * chamador fechar a espera. Turnos inteiros concorrentes no mesmo thread não são cenário: o
     * ChatService os serializa (lock `chat:thread:<id>`); a cura em si é que precisa tolerar a
     * corrida (outro turno ou o ResumeWorker).
     */
    const heal = (t: TestApp, p: Party, threadId: string, approvalId: string) =>
      as(p, () =>
        (
          t.app.get(OrchestratorService) as unknown as {
            closeResolvedWait(threadId: string, approvalId: string): Promise<void>;
          }
        ).closeResolvedWait(threadId, approvalId),
      );

    async function healsAndRuns(t: TestApp, p: Party, threadId: string, approvalId: string) {
      expect(await awaiting(t, p, threadId)).toBe(true); // bloqueado
      // Duas curas concorrentes (mesma visão antiga do thread): as duas terminam sem erro.
      await Promise.all([heal(t, p, threadId, approvalId), heal(t, p, threadId, approvalId)]);
      expect(await awaiting(t, p, threadId)).toBe(false);
      // Turnos em sequência (como o ChatService garante) seguem livres.
      for (const q of ["qual o saldo da minha carteira?", "e agora?"]) {
        const events = await turn(t, p, threadId, q);
        expect(events.length).toBeGreaterThan(0);
        expect(events.some((e) => e.type === "approval_required")).toBe(false);
      }
      expect(placeTrade).not.toHaveBeenCalled();
      expect(await execution(p, approvalId)).toBeUndefined();
      expect(await usage(p)).toEqual([]);
    }

    it("rejeitada com resume perdido: novo turno fecha a espera (rejected) e passa", async () => {
      const t = await start();
      const A = await party(t, "Cura rejeitada");
      const { threadId, approvalId } = await lost(t, A);
      await decide(t, A, approvalId, false);
      await redis.del("jobs");
      await healsAndRuns(t, A, threadId, approvalId);
      expect(await approvalStatus(A, approvalId)).toBe("rejected");
    });

    it("expired no banco com resume perdido: novo turno cura e passa", async () => {
      const t = await start();
      const A = await party(t, "Cura expirada");
      const { threadId, approvalId } = await lost(t, A);
      offset = 25 * HOUR;
      await t.app.get(ReconciliationJob).run({ onlyTenants: [A.tenantId] });
      expect(await approvalStatus(A, approvalId)).toBe("expired");
      await redis.del("jobs");
      await healsAndRuns(t, A, threadId, approvalId);
    });

    it("pending já vencida pelo CLOCK (job ainda não rodou): novo turno a vence e passa", async () => {
      const t = await start();
      const A = await party(t, "Cura vencida");
      const { threadId, approvalId } = await lost(t, A);
      offset = 25 * HOUR;
      await healsAndRuns(t, A, threadId, approvalId);
      expect(await approvalStatus(A, approvalId)).toBe("expired");
    });

    it("corrida: a cura de quem leu o estado antes não falha depois que outro turno já curou e começou (pending zerado pelo classify)", async () => {
      const t = await start();
      const A = await party(t, "Cura em corrida");
      const { threadId, approvalId } = await lost(t, A);
      await decide(t, A, approvalId, false);
      await redis.del("jobs");

      // Segura o turno 1 na busca (nó retrieve): o checkpoint do classify, com `pending: null`,
      // já foi gravado (durability "sync").
      const knowledge = t.app.get(KnowledgeService);
      const original = knowledge.search.bind(knowledge);
      const reached = deferred<undefined>();
      const gate = deferred<undefined>();
      const spy = vi.spyOn(knowledge, "search").mockImplementationOnce(async (...args) => {
        reached.resolve(undefined);
        await gate.promise;
        return original(...args);
      });
      let turn1: Promise<ChatEvent[]> | undefined;
      try {
        turn1 = turn(t, A, threadId, "como está minha carteira?");
        await reached.promise;
        const state = await as(A, () => t.app.get(OrchestratorService).finalState(threadId));
        expect(state.pending).toBeNull();

        // O turno 2 tinha visto o thread esperando a aprovação: a cura dele não pode lançar.
        await expect(heal(t, A, threadId, approvalId)).resolves.toBeUndefined();

        gate.resolve(undefined);
        const events = await turn1;
        expect(events.some((e) => e.type === "approval_required")).toBe(false);
      } finally {
        gate.resolve(undefined);
        await turn1?.catch(() => undefined);
        spy.mockRestore();
      }
      expect(await approvalStatus(A, approvalId)).toBe("rejected");
      expect(placeTrade).not.toHaveBeenCalled();
      expect(await execution(A, approvalId)).toBeUndefined();
    });

    it("pending válida: continua 409 e nada executa", async () => {
      const t = await start();
      const A = await party(t, "Cura pendente");
      const { threadId, approvalId } = await lost(t, A);
      await expect(turn(t, A, threadId, "olá")).rejects.toThrow(ApprovalConflictError);
      await expect(turn(t, A, threadId, "olá")).rejects.toThrow(/ainda não foi decidida/);
      expect(await awaiting(t, A, threadId)).toBe(true);
      expect(await approvalStatus(A, approvalId)).toBe("pending");
      expect(placeTrade).not.toHaveBeenCalled();
      expect(await execution(A, approvalId)).toBeUndefined();
    });

    it("approved com resume perdido: 409 com a mensagem certa (o job republica a execução)", async () => {
      const t = await start();
      const A = await party(t, "Cura aprovada");
      const { threadId, approvalId } = await lost(t, A);
      await decide(t, A, approvalId, true);
      await redis.del("jobs");
      await expect(turn(t, A, threadId, "olá")).rejects.toThrow(/aprovada.*retomada/);
      expect(await awaiting(t, A, threadId)).toBe(true);
      expect(placeTrade).not.toHaveBeenCalled();
      expect(await execution(A, approvalId)).toBeUndefined();
    });
  });
});
