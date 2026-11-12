/**
 * Inbox: solicitação idempotente, decisão travada (FOR UPDATE) e execução no máximo uma vez,
 * contra Postgres e Redis reais. O relógio (CLOCK) é controlado pelo teste.
 */
import { randomUUID } from "node:crypto";
import type { StreamEvent } from "@carina/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import {
  ApprovalConflictError,
  NotFoundError,
  ValidationError,
} from "../../src/core/errors/domain-errors.js";
import { REDIS } from "../../src/core/redis/redis.tokens.js";
import { StreamsService } from "../../src/core/redis/streams.service.js";
import { BillingService } from "../../src/modules/billing/billing.service.js";
import { ExecutorRegistry } from "../../src/modules/inbox/executors.js";
import { InboxService, INBOX_LOGGER } from "../../src/modules/inbox/inbox.service.js";
import { InboxModule } from "../../src/modules/inbox/inbox.module.js";
import { ReconciliationJob } from "../../src/modules/inbox/reconciliation.job.js";
import { CLOCK } from "../../src/modules/limits/clock.js";
import type { AuthTenant } from "../../src/modules/tenancy/api-key.guard.js";
import { createTestApp, type SeededTenant, type TestApp } from "../setup/app.js";
import { migratorSql, must } from "../setup/db.js";
import type { Redis } from "ioredis";

const MIN = 60_000;
const HOUR = 60 * MIN;

interface Party {
  seeded: SeededTenant;
  tenantId: string;
  clientId: string;
  keyId: string;
  by: AuthTenant;
}

describe("Inbox (int)", () => {
  let t: TestApp;
  let inbox: InboxService;
  let registry: ExecutorRegistry;
  let job: ReconciliationJob;
  let billing: BillingService;
  let streams: StreamsService;
  let redis: Redis;
  let A: Party;
  let B: Party;
  let offset = 0;
  const logs: { level: string; fields: Record<string, unknown> }[] = [];

  const asParty = <R>(p: Party, fn: () => Promise<R>) =>
    TenantContext.run({ tenantId: p.tenantId, clientId: p.clientId }, fn);
  const asTenantOnly = <R>(p: Party, fn: () => Promise<R>) =>
    TenantContext.run({ tenantId: p.tenantId }, fn);

  async function party(name: string): Promise<Party> {
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
    const keyId = must(k).id;
    return {
      seeded,
      tenantId: seeded.tenantId,
      clientId: must(c).id,
      keyId,
      by: {
        keyId,
        tenantId: seeded.tenantId,
        tenantName: name,
        scopes: ["chat", "inbox:decide"],
        rpm: 1000,
        monthlyQuota: 0,
      },
    };
  }

  const reqInput = (p: Party, over: Record<string, unknown> = {}) => ({
    threadId: `${p.tenantId}:${p.clientId}:${randomUUID()}`,
    agent: "executor",
    action: "place_trade",
    payload: { symbol: "PETR4", qty: 100 },
    valueBrl: "10000.00",
    ...over,
  });

  const request = (p: Party, over: Record<string, unknown> = {}) =>
    asParty(p, () => inbox.request(reqInput(p, over) as Parameters<InboxService["request"]>[0]));

  /** Cria e aprova uma solicitação; devolve o id. */
  async function approved(p: Party, over: Record<string, unknown> = {}): Promise<string> {
    const { approvalId } = await request(p, over);
    await asTenantOnly(p, () => inbox.decide(approvalId, { approved: true }, p.by));
    return approvalId;
  }

  async function events(stream: string): Promise<StreamEvent[]> {
    const rows = await redis.xrange(stream, "-", "+");
    return rows.map(([, f]) => JSON.parse(f[1] as string) as StreamEvent);
  }

  /** Eventos `resume` só dos tenants A e B deste teste (o job varre todos os tenants do banco). */
  const resumesAB = async () =>
    (await events("jobs")).filter(
      (e): e is Extract<StreamEvent, { type: "resume" }> =>
        e.type === "resume" && [A.tenantId, B.tenantId].includes(e.tenantId),
    );

  const row = async (p: Party, id: string) =>
    (
      await migratorSql<Record<string, unknown>>(
        `SELECT * FROM approval_request WHERE id = $1`,
        [id],
        {
          tenantId: p.tenantId,
        },
      )
    )[0];
  const exec = async (p: Party, id: string) =>
    (
      await migratorSql<Record<string, unknown>>(
        `SELECT * FROM executed_action WHERE approval_request_id = $1`,
        [id],
        { tenantId: p.tenantId },
      )
    )[0];
  const usage = (p: Party) =>
    migratorSql<Record<string, unknown>>(
      `SELECT * FROM usage_record WHERE work_type = 'execution'`,
      [],
      {
        tenantId: p.tenantId,
      },
    );
  const audits = (p: Party) =>
    migratorSql<Record<string, unknown>>(`SELECT * FROM audit_event WHERE channel = 'worker'`, [], {
      tenantId: p.tenantId,
    });

  beforeAll(async () => {
    t = await createTestApp({
      imports: [InboxModule],
      redisDb: 5,
      overrides: [
        { token: CLOCK, useValue: () => Date.now() + offset },
        {
          token: INBOX_LOGGER,
          useValue: {
            warn: (fields: Record<string, unknown>) => logs.push({ level: "warn", fields }),
            error: (fields: Record<string, unknown>) => logs.push({ level: "error", fields }),
          },
        },
      ],
    });
    inbox = t.app.get(InboxService);
    registry = t.app.get(ExecutorRegistry);
    job = t.app.get(ReconciliationJob);
    billing = t.app.get(BillingService);
    streams = t.app.get(StreamsService);
    redis = t.app.get<Redis>(REDIS);
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(async () => {
    // Tenants novos a cada teste: cobrança e auditoria são append-only e os testes contam linhas.
    A = await party("A");
    B = await party("B");
    offset = 0;
    logs.length = 0;
    vi.restoreAllMocks();
    await redis.flushdb();
    // executores simulados padrão de volta
    registry.resetDefaults();
  });

  describe("request", () => {
    it("duas chamadas com os mesmos dados: uma linha e um único approval.created", async () => {
      const input = reqInput(A);
      const first = await asParty(A, () =>
        inbox.request(input as Parameters<InboxService["request"]>[0]),
      );
      const second = await asParty(A, () =>
        inbox.request(input as Parameters<InboxService["request"]>[0]),
      );
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.approvalId).toBe(first.approvalId);
      const rows = await migratorSql(
        `SELECT id FROM approval_request WHERE id = $1`,
        [first.approvalId],
        {
          tenantId: A.tenantId,
        },
      );
      expect(rows).toHaveLength(1);
      const created = (await events("inbox.events")).filter((e) => e.type === "approval.created");
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        tenantId: A.tenantId,
        clientId: A.clientId,
        approvalId: first.approvalId,
      });
    });

    it("grava risco, valor e expires_at = agora (CLOCK) + APPROVAL_TTL_HOURS (24h)", async () => {
      offset = 5 * HOUR;
      const before = Date.now() + offset;
      const { approvalId } = await request(A);
      const r = await row(A, approvalId);
      expect(r).toMatchObject({ status: "pending", risk: "irreversible", action: "place_trade" });
      expect(String(r?.["value_brl"])).toBe("10000.00");
      const exp = (r?.["expires_at"] as Date).getTime();
      expect(exp).toBeGreaterThanOrEqual(before + 24 * HOUR);
      expect(exp).toBeLessThan(before + 24 * HOUR + 10_000);
    });

    it.each([
      ["acima do limite (1e16)", "10000000000000000.00"],
      ["número em vez de string", 1e16],
      ["negativo", "-1.00"],
      ["três casas decimais", "1.001"],
      ["texto", "muito"],
      ["vazio", ""],
      ["notação científica", "1e3"],
    ])("valueBrl %s: ValidationError (422) e nenhuma linha", async (_name, valueBrl) => {
      const input = reqInput(A, { valueBrl });
      await expect(
        asParty(A, () => inbox.request(input as Parameters<InboxService["request"]>[0])),
      ).rejects.toBeInstanceOf(ValidationError);
      const rows = await migratorSql(
        `SELECT id FROM approval_request WHERE thread_id = $1`,
        [input.threadId],
        {
          tenantId: A.tenantId,
        },
      );
      expect(rows).toEqual([]);
      expect(await events("inbox.events")).toEqual([]);
    });

    it("aceita o maior valor permitido e zero", async () => {
      await expect(request(A, { valueBrl: "9999999999999999.99" })).resolves.toMatchObject({
        created: true,
      });
      await expect(request(A, { valueBrl: "0" })).resolves.toMatchObject({ created: true });
    });

    it("thread de outro tenant/cliente, agente inválido ou sem cliente no contexto: ValidationError", async () => {
      await expect(
        request(A, { threadId: `${B.tenantId}:${B.clientId}:${randomUUID()}` }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(request(A, { threadId: "qualquer" })).rejects.toBeInstanceOf(ValidationError);
      await expect(request(A, { agent: "hacker" })).rejects.toBeInstanceOf(ValidationError);
      await expect(request(A, { action: "" })).rejects.toBeInstanceOf(ValidationError);
      await expect(
        asTenantOnly(A, () => inbox.request(reqInput(A) as Parameters<InboxService["request"]>[0])),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("falha ao publicar approval.created não desfaz a solicitação (logada sem payload)", async () => {
      vi.spyOn(streams, "publish").mockRejectedValue(new Error("redis fora"));
      const res = await request(A, { payload: { segredo: "PAYLOAD-SENSIVEL" } });
      expect(res.created).toBe(true);
      expect(await row(A, res.approvalId)).toMatchObject({ status: "pending" });
      expect(logs.some((l) => l.level === "error" && l.fields["err"] instanceof Error)).toBe(true);
      expect(JSON.stringify(logs.map((l) => l.fields["msg"]))).not.toContain("PAYLOAD-SENSIVEL");
      expect(
        JSON.stringify(logs, (_k, v: unknown) => (v instanceof Error ? v.message : v)),
      ).not.toContain("PAYLOAD-SENSIVEL");
    });
  });

  describe("listPending / get", () => {
    it("lista só as pendentes e não vencidas do cliente, nunca de outro tenant", async () => {
      const a1 = await request(A);
      await request(A, { payload: { qty: 2 } });
      const decided = await request(A, { payload: { qty: 3 } });
      await asTenantOnly(A, () => inbox.decide(decided.approvalId, { approved: false }, A.by));
      const b1 = await request(B);

      const listA = await asTenantOnly(A, () => inbox.listPending("cli-1"));
      expect(listA).toHaveLength(2);
      expect(listA.map((v) => v.id)).toContain(a1.approvalId);
      expect(listA.map((v) => v.id)).not.toContain(b1.approvalId);
      expect(listA[0]).toMatchObject({
        clientId: "cli-1",
        status: "pending",
        risk: "irreversible",
        valueBrl: "10000.00",
      });
      const listB = await asTenantOnly(B, () => inbox.listPending("cli-1"));
      expect(listB.map((v) => v.id)).toEqual([b1.approvalId]);

      offset = 25 * HOUR; // todas vencidas
      expect(await asTenantOnly(A, () => inbox.listPending("cli-1"))).toEqual([]);
    });

    it("cliente inexistente: NotFoundError; get de outro tenant e de id inexistente: NotFoundError", async () => {
      await expect(asTenantOnly(A, () => inbox.listPending("nao-existe"))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      const b = await request(B);
      await expect(asTenantOnly(A, () => inbox.get(b.approvalId))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(asTenantOnly(A, () => inbox.get("0".repeat(64)))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(asTenantOnly(A, () => inbox.get("lixo"))).rejects.toBeInstanceOf(NotFoundError);
      const a = await request(A);
      await expect(asTenantOnly(A, () => inbox.get(a.approvalId))).resolves.toMatchObject({
        id: a.approvalId,
      });
    });
  });

  describe("decide", () => {
    it("duas decisões aprovando em paralelo: uma resolve, a outra ApprovalConflictError; um só resume", async () => {
      const { approvalId } = await request(A);
      const results = await Promise.allSettled([
        asTenantOnly(A, () => inbox.decide(approvalId, { approved: true }, A.by)),
        asTenantOnly(A, () => inbox.decide(approvalId, { approved: true }, A.by)),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ApprovalConflictError);
      const resumes = (await events("jobs")).filter((e) => e.type === "resume");
      expect(resumes).toHaveLength(1);
      expect(resumes[0]).toMatchObject({
        tenantId: A.tenantId,
        clientId: A.clientId,
        approvalId,
        approved: true,
      });
      expect(resumes[0]).toHaveProperty("threadId");
    });

    it("aprovar e rejeitar em paralelo: só uma decisão vale", async () => {
      const { approvalId } = await request(A);
      const results = await Promise.allSettled([
        asTenantOnly(A, () => inbox.decide(approvalId, { approved: true }, A.by)),
        asTenantOnly(A, () => inbox.decide(approvalId, { approved: false, reason: "não" }, A.by)),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const final = (await row(A, approvalId))?.["status"];
      const winner = results.findIndex((r) => r.status === "fulfilled");
      expect(final).toBe(winner === 0 ? "approved" : "rejected");
    });

    it("grava status, decided_by_key_id, decided_at e reason; devolve a view", async () => {
      const { approvalId } = await request(A);
      const view = await asTenantOnly(A, () =>
        inbox.decide(approvalId, { approved: false, reason: "risco alto" }, A.by),
      );
      expect(view).toMatchObject({ id: approvalId, status: "rejected", clientId: "cli-1" });
      const r = await row(A, approvalId);
      expect(r).toMatchObject({
        status: "rejected",
        decided_by_key_id: A.keyId,
        reason: "risco alto",
      });
      expect(r?.["decided_at"]).toBeInstanceOf(Date);
      const resume = (await events("jobs")).find((e) => e.type === "resume");
      expect(resume).toMatchObject({ approved: false, approvalId });
    });

    it("inexistente e de outro tenant: NotFoundError (mesma mensagem), sem efeito", async () => {
      const b = await request(B);
      const e1 = await asTenantOnly(A, () =>
        inbox.decide(b.approvalId, { approved: true }, A.by),
      ).catch((e: unknown) => e);
      const e2 = await asTenantOnly(A, () =>
        inbox.decide("f".repeat(64), { approved: true }, A.by),
      ).catch((e: unknown) => e);
      expect(e1).toBeInstanceOf(NotFoundError);
      expect(e2).toBeInstanceOf(NotFoundError);
      expect((e1 as Error).message).toBe((e2 as Error).message);
      expect(await row(B, b.approvalId)).toMatchObject({
        status: "pending",
        decided_by_key_id: null,
      });
      expect(await events("jobs")).toEqual([]);
    });

    it("segunda decisão depois da primeira: ApprovalConflictError e nada executa", async () => {
      const spy = vi.fn(async () => ({ ok: true }));
      registry.register("place_trade", spy);
      const id = await approved(A);
      await expect(
        asTenantOnly(A, () => inbox.decide(id, { approved: false }, A.by)),
      ).rejects.toBeInstanceOf(ApprovalConflictError);
      expect(await row(A, id)).toMatchObject({ status: "approved" });
      expect(spy).not.toHaveBeenCalled();
    });

    it("vencida: marca expired (persistido), lança ApprovalConflictError e publica resume rejeitado", async () => {
      const { approvalId } = await request(A);
      offset = 25 * HOUR;
      await expect(
        asTenantOnly(A, () => inbox.decide(approvalId, { approved: true }, A.by)),
      ).rejects.toBeInstanceOf(ApprovalConflictError);
      expect(await row(A, approvalId)).toMatchObject({
        status: "expired",
        decided_by_key_id: null,
      });
      const resumes = (await events("jobs")).filter((e) => e.type === "resume");
      expect(resumes).toHaveLength(1);
      expect(resumes[0]).toMatchObject({ approved: false, approvalId });
      // E continua não executando.
      await expect(asTenantOnly(A, () => inbox.executeOnce(approvalId))).resolves.toEqual({
        status: "skipped",
      });
    });

    it("falha ao publicar resume não desfaz a decisão (logada); a reconciliação republica depois de 2 min", async () => {
      const { approvalId } = await request(A, { payload: { segredo: "PAYLOAD-SENSIVEL" } });
      const spy = vi.spyOn(streams, "publish").mockRejectedValue(new Error("redis fora"));
      const view = await asTenantOnly(A, () => inbox.decide(approvalId, { approved: true }, A.by));
      expect(view.status).toBe("approved");
      expect(await row(A, approvalId)).toMatchObject({ status: "approved" });
      expect(logs.some((l) => l.level === "error" && l.fields["approvalId"] === approvalId)).toBe(
        true,
      );
      expect(
        JSON.stringify(logs, (_k, v: unknown) => (v instanceof Error ? v.message : v)),
      ).not.toContain("PAYLOAD-SENSIVEL");
      spy.mockRestore();
      expect((await events("jobs")).filter((e) => e.type === "resume")).toEqual([]);

      offset = 3 * MIN;
      await job.run();
      const resumes = await resumesAB();
      expect(resumes).toHaveLength(1);
      expect(resumes[0]).toMatchObject({ approvalId, approved: true });
    });
  });

  describe("executeOnce", () => {
    it("dois em paralelo: o executor roda uma vez, um devolve skipped, cobra uma vez e publica uma vez", async () => {
      const spy = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { orderId: "SIM-DEADBEEF", status: "filled" };
      });
      registry.register("place_trade", spy);
      const id = await approved(A, { valueBrl: "100000.00" });

      const results = await Promise.all([
        asTenantOnly(A, () => inbox.executeOnce(id)),
        asTenantOnly(A, () => inbox.executeOnce(id)),
      ]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(results.map((r) => r.status).sort()).toEqual(["skipped", "succeeded"]);
      expect(results.find((r) => r.status === "succeeded")?.result).toEqual({
        orderId: "SIM-DEADBEEF",
        status: "filled",
      });

      expect(await exec(A, id)).toMatchObject({
        status: "succeeded",
        result: { orderId: "SIM-DEADBEEF", status: "filled" },
      });
      expect((await exec(A, id))?.["finished_at"]).toBeInstanceOf(Date);
      const u = await usage(A);
      expect(u).toHaveLength(1);
      expect(String(u[0]?.["price_brl"])).toBe("575.00");
      expect(String(u[0]?.["fee_brl"])).toBe("500.00");
      expect(String(u[0]?.["value_brl"])).toBe("100000.00");
      expect(u[0]?.["client_id"]).toBe(A.clientId);
      const au = await audits(A);
      expect(au).toHaveLength(1);
      expect(au[0]).toMatchObject({ client_id: A.clientId, channel: "worker" });
      const executed = (await events("inbox.events")).filter((e) => e.type === "approval.executed");
      expect(executed).toHaveLength(1);
      expect(executed[0]).toMatchObject({
        approvalId: id,
        status: "succeeded",
        clientId: A.clientId,
      });
    });

    it("chamado de novo depois de concluído: skipped, sem executar nem cobrar de novo", async () => {
      const spy = vi.fn(async () => ({ ok: 1 }));
      registry.register("place_trade", spy);
      const id = await approved(A);
      await asTenantOnly(A, () => inbox.executeOnce(id));
      await expect(asTenantOnly(A, () => inbox.executeOnce(id))).resolves.toEqual({
        status: "skipped",
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await usage(A)).toHaveLength(1);
    });

    it("rejeitada, pendente, vencida ou inexistente: skipped, executor nunca chamado", async () => {
      const spy = vi.fn(async () => ({}));
      registry.register("place_trade", spy);
      const rejected = await request(A, { payload: { n: 1 } });
      await asTenantOnly(A, () => inbox.decide(rejected.approvalId, { approved: false }, A.by));
      const pending = await request(A, { payload: { n: 2 } });
      const expired = await request(A, { payload: { n: 3 } });
      await migratorSql(
        `UPDATE approval_request SET status = 'expired' WHERE id = $1`,
        [expired.approvalId],
        {
          tenantId: A.tenantId,
        },
      );
      for (const id of [
        rejected.approvalId,
        pending.approvalId,
        expired.approvalId,
        "a".repeat(64),
      ]) {
        await expect(asTenantOnly(A, () => inbox.executeOnce(id))).resolves.toEqual({
          status: "skipped",
        });
        expect(await exec(A, id)).toBeUndefined();
      }
      expect(spy).not.toHaveBeenCalled();
      expect(await usage(A)).toEqual([]);
    });

    it("executor que lança: failed, resultado com o erro, sem cobrança nem auditoria; publica approval.executed failed", async () => {
      registry.register("place_trade", async () => {
        throw new Error("corretora fora do ar");
      });
      const id = await approved(A);
      const res = await asTenantOnly(A, () => inbox.executeOnce(id));
      expect(res.status).toBe("failed");
      expect(await exec(A, id)).toMatchObject({ status: "failed" });
      expect(JSON.stringify((await exec(A, id))?.["result"])).toContain("corretora fora do ar");
      expect(await usage(A)).toEqual([]);
      expect(await audits(A)).toEqual([]);
      const executed = (await events("inbox.events")).filter((e) => e.type === "approval.executed");
      expect(executed).toHaveLength(1);
      expect(executed[0]).toMatchObject({ approvalId: id, status: "failed" });
      // Nunca reexecuta automaticamente.
      await expect(asTenantOnly(A, () => inbox.executeOnce(id))).resolves.toEqual({
        status: "skipped",
      });
    });

    it("ação sem executor registrado: failed, sem cobrança", async () => {
      const id = await approved(A, { action: "pix_out" });
      const res = await asTenantOnly(A, () => inbox.executeOnce(id));
      expect(res.status).toBe("failed");
      expect(await usage(A)).toEqual([]);
    });

    it("falha na cobrança: billing, auditoria e status succeeded revertem juntos; a linha vira needs_review com o resultado; nunca reexecuta", async () => {
      const spy = vi.fn(async () => ({ orderId: "SIM-0000000A", status: "filled" }));
      registry.register("place_trade", spy);
      vi.spyOn(billing, "record").mockRejectedValueOnce(new Error("falha injetada no billing"));
      const id = await approved(A, { payload: { segredo: "PAYLOAD-SENSIVEL" } });

      await expect(asTenantOnly(A, () => inbox.executeOnce(id))).rejects.toThrow(
        "falha injetada no billing",
      );

      expect(spy).toHaveBeenCalledTimes(1); // o efeito externo aconteceu
      const e = await exec(A, id);
      expect(e).toMatchObject({ status: "needs_review" });
      expect(JSON.stringify(e?.["result"])).toContain("SIM-0000000A"); // o operador vê o que aconteceu
      expect(await usage(A)).toEqual([]);
      expect(await audits(A)).toEqual([]);
      expect((await events("inbox.events")).filter((x) => x.type === "approval.executed")).toEqual(
        [],
      );
      expect(
        JSON.stringify(logs, (_k, v: unknown) => (v instanceof Error ? v.message : v)),
      ).not.toContain("PAYLOAD-SENSIVEL");
      expect(logs.some((l) => l.level === "error" && l.fields["approvalId"] === id)).toBe(true);

      await expect(asTenantOnly(A, () => inbox.executeOnce(id))).resolves.toEqual({
        status: "skipped",
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("falha na auditoria também reverte a cobrança (mesma transação)", async () => {
      registry.register("place_trade", async () => ({ ok: true }));
      const watchtower = t.app.get(
        (await import("../../src/modules/watchtower/watchtower.service.js")).WatchtowerService,
      );
      vi.spyOn(watchtower, "review").mockRejectedValueOnce(
        new Error("falha injetada na auditoria"),
      );
      const id = await approved(A);
      await expect(asTenantOnly(A, () => inbox.executeOnce(id))).rejects.toThrow(
        "falha injetada na auditoria",
      );
      expect(await usage(A)).toEqual([]);
      expect(await exec(A, id)).toMatchObject({ status: "needs_review" });
    });

    it("executores simulados padrão: formatos de place_trade, transfer, rebalance, create_alert e leituras", async () => {
      expect(await must(registry.get("place_trade"))({})).toMatchObject({ status: "filled" });
      expect(
        ((await must(registry.get("place_trade"))({})) as { orderId: string }).orderId,
      ).toMatch(/^SIM-[0-9a-f]{8}$/);
      for (const a of ["transfer", "rebalance"]) {
        const r = (await must(registry.get(a))({})) as { protocol: string; status: string };
        expect(r.protocol).toMatch(/^SIM-/);
        expect(r.status).toBe("accepted");
      }
      expect(await must(registry.get("create_alert"))({})).toHaveProperty("alertId");
      expect(registry.get("get_positions")).toBeTypeOf("function");
      expect(registry.get("get_transactions")).toBeTypeOf("function");
      expect(registry.get("pix_out")).toBeUndefined();
    });
  });

  describe("isolamento entre tenants", () => {
    it("executeOnce/decide de um tenant nunca tocam o outro; dados nos dois lados", async () => {
      const spyA = vi.fn(async () => ({ lado: "A" }));
      registry.register("place_trade", spyA);
      const idA = await approved(A, { payload: { x: 1 } });
      const idB = await approved(B, { payload: { x: 1 } });
      expect(idA).not.toBe(idB); // threadId distinto (contém o tenant)

      // B tenta executar a aprovação de A: nada acontece
      await expect(asTenantOnly(B, () => inbox.executeOnce(idA))).resolves.toEqual({
        status: "skipped",
      });
      expect(spyA).not.toHaveBeenCalled();
      expect(await exec(A, idA)).toBeUndefined();
      // B tenta decidir a de A
      await expect(
        asTenantOnly(B, () => inbox.decide(idA, { approved: false }, B.by)),
      ).rejects.toBeInstanceOf(NotFoundError);

      await asTenantOnly(A, () => inbox.executeOnce(idA));
      expect(await usage(A)).toHaveLength(1);
      expect(await usage(B)).toEqual([]);
      expect(await exec(B, idB)).toBeUndefined();
      await asTenantOnly(B, () => inbox.executeOnce(idB));
      expect(await usage(B)).toHaveLength(1);
      expect(await usage(A)).toHaveLength(1);
    });
  });

  describe("ReconciliationJob", () => {
    it("com o relógio adiantado: expira pendentes (resume rejeitado), republica approved sem execução, marca started antigo como needs_review sem chamar o executor", async () => {
      const spy = vi.fn(async () => ({}));
      for (const a of ["place_trade"]) registry.register(a, spy);

      // Em ambos os tenants.
      const out: Record<
        string,
        { pending: string; stuckApproved: string; started: string; fresh: string }
      > = {};
      for (const [name, p] of [
        ["A", A],
        ["B", B],
      ] as const) {
        const pending = (await request(p, { payload: { k: "pending" } })).approvalId;
        const stuckApproved = await approved(p, { payload: { k: "stuck" } });
        const started = await approved(p, { payload: { k: "started" } });
        const fresh = await approved(p, { payload: { k: "fresh" } });
        // `started` e `fresh` já têm executed_action em andamento (o executor "morreu")
        await migratorSql(
          `INSERT INTO executed_action (approval_request_id, tenant_id, client_id, status, started_at)
           VALUES ($1, $3, $4, 'started', now()), ($2, $3, $4, 'started', now() + interval '4 minutes')`,
          [started, fresh, p.tenantId, p.clientId],
          { tenantId: p.tenantId },
        );
        out[name] = { pending, stuckApproved, started, fresh };
      }
      await redis.flushdb(); // só os eventos da reconciliação importam

      // 6 min: started (agora) venceu os 5 min; fresh (agora+4) ainda não; stuck (>2 min) republica; pending ainda vale.
      offset = 6 * MIN;
      await job.run();
      for (const p of [A, B]) {
        const o = must(out[p === A ? "A" : "B"]);
        expect(await exec(p, o.started)).toMatchObject({ status: "needs_review" });
        expect(await exec(p, o.fresh)).toMatchObject({ status: "started" });
        expect(await row(p, o.pending)).toMatchObject({ status: "pending" });
      }
      let resumes = await resumesAB();
      const approvedIds = resumes
        .filter((r) => r.approved)
        .map((r) => r.approvalId)
        .sort();
      // stuck e (started, fresh: approved sem executed_action? não: têm executed_action) → só os stuck de A e B
      expect(approvedIds).toEqual(
        [must(out["A"]).stuckApproved, must(out["B"]).stuckApproved].sort(),
      );
      expect(resumes.filter((r) => !r.approved)).toEqual([]);

      // 25h: as pendentes vencem
      await redis.flushdb();
      offset = 25 * HOUR;
      await job.run();
      for (const p of [A, B]) {
        const o = must(out[p === A ? "A" : "B"]);
        expect(await row(p, o.pending)).toMatchObject({ status: "expired" });
        expect(await exec(p, o.fresh)).toMatchObject({ status: "needs_review" });
      }
      resumes = await resumesAB();
      expect(
        resumes
          .filter((r) => !r.approved)
          .map((r) => r.approvalId)
          .sort(),
      ).toEqual([must(out["A"]).pending, must(out["B"]).pending].sort());
      expect(spy).not.toHaveBeenCalled(); // needs_review nunca reexecuta

      // Rodar de novo não repete nada do que já foi resolvido (expiradas e needs_review são terminais).
      await redis.flushdb();
      await job.run();
      const again = (await resumesAB()).filter((e) => !e.approved);
      expect(again).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
      // E executeOnce segue pulando o needs_review.
      await expect(
        asTenantOnly(A, () => inbox.executeOnce(must(out["A"]).started)),
      ).resolves.toEqual({ status: "skipped" });
      expect(spy).not.toHaveBeenCalled();
    });

    it("approved há menos de 2 min não é republicado", async () => {
      const id = await approved(A, { payload: { k: "recente" } });
      await redis.flushdb();
      offset = 90_000;
      await job.run();
      expect(
        (await events("jobs")).filter((e) => e.type === "resume" && e.approvalId === id),
      ).toEqual([]);
    });

    it("uma execução que termina depois do needs_review não sobrescreve o estado (e não cobra)", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      registry.register("place_trade", async () => {
        await gate;
        return { ok: true };
      });
      const id = await approved(A, { payload: { k: "lento" } });
      const running = asTenantOnly(A, () => inbox.executeOnce(id)).catch((e: unknown) => e);
      // espera o INSERT 'started'
      for (let i = 0; i < 100 && !(await exec(A, id)); i++)
        await new Promise((r) => setTimeout(r, 20));
      offset = 6 * MIN;
      await job.run();
      expect(await exec(A, id)).toMatchObject({ status: "needs_review" });
      release();
      await running;
      expect(await exec(A, id)).toMatchObject({ status: "needs_review" });
      expect(await usage(A)).toEqual([]);
    });

    it("tick concorrente entre réplicas: o lock faz uma delas pular", async () => {
      const id = await request(A, { payload: { k: "lock" } });
      offset = 25 * HOUR;
      const results = await Promise.all([job.run(), job.run()]);
      expect(results.filter((r) => r.skipped)).toHaveLength(1);
      expect(
        (await events("jobs")).filter((e) => e.type === "resume" && e.approvalId === id.approvalId),
      ).toHaveLength(1);
    });

    it("não liga o timer com workers desligados; start/stop são idempotentes e não deixam timer", async () => {
      expect(job.running).toBe(false);
      job.start();
      job.start();
      expect(job.running).toBe(true);
      await job.stop();
      await job.stop();
      expect(job.running).toBe(false);
    });
  });
});
