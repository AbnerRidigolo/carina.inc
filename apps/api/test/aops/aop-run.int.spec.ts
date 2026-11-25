/**
 * Execução dos AOPs fim a fim (spec §4.4): AopsCoreModule com Nest, Postgres e Redis reais e
 * LLM_MODE=mock (os agentes respondem pelos responders do modo mock). O AopJob roda a agenda
 * (`runOnce`) e o handler de `aop.run_requested` (`handle`) chamados direto; o relógio (CLOCK) é
 * fixado numa sexta às 9h05 de São Paulo. As gravações são lidas como carina_migrator com o tenant
 * fixado. O banco é compartilhado com os outros arquivos int: cada teste usa tenants próprios.
 *
 * Redis: o DB é DIVIDIDO com app/app-graph.int.spec.ts (test/setup/redis-dbs.ts, SHARED_REDIS_DBS),
 * que não lê nem esvazia nada: aqui nada é esvaziado nem consumido do stream `jobs`; só as chaves
 * `aops:*` e as de cota dos tenants deste arquivo são apagadas.
 */
import { randomUUID } from "node:crypto";
import type { StreamEvent } from "@carina/shared";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REDIS } from "../../src/core/redis/redis.tokens.js";
import { TenantPrismaService } from "../../src/core/database/tenant-prisma.service.js";
import { StreamsService } from "../../src/core/redis/streams.service.js";
import { AOP_LOGGER, AopRunner } from "../../src/modules/aops/aop-runner.js";
import { AopJob } from "../../src/modules/aops/aop.job.js";
import { AopsCoreModule } from "../../src/modules/aops/aops-core.module.js";
import { AopsRepository } from "../../src/modules/aops/aops.repository.js";
import { CLOCK } from "../../src/modules/limits/clock.js";
import { createTestApp, type TestApp } from "../setup/app.js";
import { migratorSql, must } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

const REDIS_DB = redisDbOf("aops/aop-run.int.spec.ts");

// 2026-11-27 é sexta; 12:05Z = 9h05 em São Paulo. O disparo semanal de sexta 9h é 12:00Z.
const FRIDAY_0905 = Date.parse("2026-11-27T12:05:00.000Z");
const FIRE_0900 = "2026-11-27T12:00:00.000Z";
const DESCRIPTION = "Toda sexta às 9h, analise a carteira e o risco dos clientes premium";

describe("AOPs: execução no worker (AopJob + AopRunner, LLM mock)", () => {
  let t: TestApp;
  let redis: Redis;
  let job: AopJob;
  const logged: unknown[] = [];
  const tenants: string[] = [];

  /** Tenant com clientes `externalIds` (devolve externalId → uuid interno). */
  async function tenantWith(externalIds: string[], monthlyQuota = 0) {
    const tenantId = randomUUID();
    tenants.push(tenantId);
    await migratorSql(
      `INSERT INTO tenant (id, name, plan, monthly_quota) VALUES ($1, 'AOP run', 'pro', $2)`,
      [tenantId, monthlyQuota],
    );
    const clients: Record<string, string> = {};
    for (const ext of externalIds) {
      const id = randomUUID();
      clients[ext] = id;
      await migratorSql(
        `INSERT INTO client (id, tenant_id, external_id) VALUES ($1, $2, $3)`,
        [id, tenantId, ext],
        { tenantId },
      );
    }
    return { tenantId, clients };
  }

  async function aopFor(tenantId: string, clientIds: string[], agents = ["insight", "risk"]) {
    const rows = await migratorSql<{ id: string }>(
      `INSERT INTO aop (tenant_id, name, description, agents, frequency, weekday, day, hour,
                        client_ids)
       VALUES ($1, 'Carteira premium', $2, $3, 'weekly', 4, 1, 9, $4) RETURNING id::text`,
      [tenantId, DESCRIPTION, agents, clientIds],
      { tenantId },
    );
    return must(rows[0]).id;
  }

  const runsOf = (tenantId: string) =>
    migratorSql<{
      client_id: string;
      fire_at: Date;
      trigger: string;
      status: string;
      failure_code: string | null;
      results: Record<string, unknown>;
      work_type: string | null;
      price_brl: string | null;
      audit_id: string | null;
    }>(
      `SELECT client_id::text, fire_at, trigger, status, failure_code, results, work_type,
              price_brl::text, audit_id::text
         FROM aop_run ORDER BY created_at, client_id`,
      [],
      { tenantId },
    );

  const usageOf = (tenantId: string) =>
    migratorSql<{ client_id: string; work_type: string; agents: string[]; price_brl: string }>(
      `SELECT client_id::text, work_type, agents, price_brl::text FROM usage_record
        ORDER BY created_at, client_id`,
      [],
      { tenantId },
    );

  const auditOf = (tenantId: string) =>
    migratorSql<{ id: string; client_id: string; channel: string; query: string }>(
      `SELECT id::text, client_id::text, channel, query FROM audit_event
        ORDER BY created_at, client_id`,
      [],
      { tenantId },
    );

  const lastFireOf = async (aopId: string, tenantId: string) =>
    must(
      (
        await migratorSql<{ last_fire_at: Date | null }>(
          `SELECT last_fire_at FROM aop WHERE id = $1`,
          [aopId],
          { tenantId },
        )
      )[0],
    ).last_fire_at;

  const manual = (tenantId: string, aopId: string, fireAt: string): StreamEvent => ({
    type: "aop.run_requested",
    eventId: randomUUID(),
    tenantId,
    clientId: "",
    aopId,
    fireAt,
  });

  /** Só as chaves deste arquivo: o DB é dividido (ver o topo). */
  const clearKeys = async () => {
    const keys = [
      ...(await redis.keys("aops:*")),
      ...(await Promise.all(tenants.map((id) => redis.keys(`quota:${id}:*`)))).flat(),
    ];
    if (keys.length > 0) await redis.del(...keys);
  };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [AopsCoreModule],
      redisDb: REDIS_DB,
      overrides: [
        { token: CLOCK, useValue: () => FRIDAY_0905 },
        {
          token: AOP_LOGGER,
          useValue: {
            info: (f: unknown) => logged.push(f),
            warn: (f: unknown) => logged.push(f),
            error: (f: unknown) => logged.push(f),
          },
        },
      ],
    });
    redis = t.app.get<Redis>(REDIS);
    job = t.app.get(AopJob);
  });

  afterAll(async () => {
    await clearKeys();
    await t.close();
  });

  beforeEach(async () => {
    await clearKeys();
  });

  it("AOP semanal vencido → aop_run gravado, usage_record e audit_event com o cliente certo", async () => {
    const { tenantId, clients } = await tenantWith(["a1", "a2"]);
    const aopId = await aopFor(tenantId, ["a1", "a2"]);

    expect(await job.runOnce({ onlyTenants: [tenantId] })).toEqual({
      skipped: false,
      tenants: 1,
      fired: 1,
      failed: 0,
    });

    expect((await lastFireOf(aopId, tenantId))?.toISOString()).toBe(FIRE_0900);
    const runs = await runsOf(tenantId);
    expect(runs.map((r) => r.client_id).sort()).toEqual([clients["a1"], clients["a2"]].sort());
    for (const r of runs) {
      expect(r).toMatchObject({
        trigger: "schedule",
        status: "ok",
        failure_code: null,
        work_type: "multi_agent_analysis",
        price_brl: "15.00",
      });
      expect(r.fire_at.toISOString()).toBe(FIRE_0900);
      expect(Object.keys(r.results).sort()).toEqual(["insight", "risk"]);
      expect(r.results["insight"]).not.toEqual({ failed: true });
    }

    const usage = await usageOf(tenantId);
    expect(usage.map((u) => u.client_id).sort()).toEqual(runs.map((r) => r.client_id).sort());
    for (const u of usage) {
      expect(u).toMatchObject({ work_type: "multi_agent_analysis", agents: ["insight", "risk"] });
    }
    const audit = await auditOf(tenantId);
    expect(audit.map((a) => a.client_id).sort()).toEqual(runs.map((r) => r.client_id).sort());
    for (const a of audit) {
      expect(a.channel).toBe("worker");
      expect(a.query.startsWith("[AOP:Carteira premium] Toda sexta")).toBe(true);
    }
    // o aop_run aponta o evento do Watchtower do próprio cliente
    for (const r of runs) {
      expect(audit.find((a) => a.id === r.audit_id)?.client_id).toBe(r.client_id);
    }

    // o tick seguinte não dispara de novo
    expect((await job.runOnce({ onlyTenants: [tenantId] })).fired).toBe(0);
    expect(await runsOf(tenantId)).toHaveLength(2);
    expect(await usageOf(tenantId)).toHaveLength(2);
    // logs só com ids e contagens
    expect(JSON.stringify(logged)).not.toContain("analise a carteira");
  });

  it("duas réplicas no mesmo fire (sem o lock global entre elas) → roda uma vez (claimFire)", async () => {
    const { tenantId } = await tenantWith(["a1"]);
    await aopFor(tenantId, ["a1"], ["insight"]);
    // duas réplicas com o mesmo banco e runner, cada uma "com o lock" (expirado na outra)
    const freeLock = {
      acquire: () =>
        Promise.resolve({
          assertHeld: () => Promise.resolve(),
          release: () => Promise.resolve(true),
        }),
    };
    const replica = () =>
      new AopJob(
        { WORKERS_ENABLED: "false", AOP_TICK_MS: 300_000 },
        t.app.get(TenantPrismaService),
        t.app.get(AopsRepository),
        t.app.get(AopRunner),
        t.app.get(StreamsService),
        freeLock as never,
        () => FRIDAY_0905,
        { info: () => undefined, warn: () => undefined, error: () => undefined },
      );
    const [ra, rb] = await Promise.all([
      replica().runOnce({ onlyTenants: [tenantId] }),
      replica().runOnce({ onlyTenants: [tenantId] }),
    ]);
    expect(ra.fired + rb.fired).toBe(1);
    expect(await runsOf(tenantId)).toHaveLength(1);
    expect(await usageOf(tenantId)).toHaveLength(1);
  });

  it("reentrega de aop.run_requested não roda de novo nem cobra duas vezes; não toca em last_fire_at", async () => {
    const { tenantId } = await tenantWith(["a1", "a2"]);
    const aopId = await aopFor(tenantId, ["a1", "a2"]);
    const at = "2026-11-27T12:01:00.000Z";
    const event = manual(tenantId, aopId, at);

    await job.handle(event);
    await job.handle(event); // reentrega
    await job.handle({ ...event, eventId: randomUUID() }); // mesmo disparo, outro evento

    const runs = await runsOf(tenantId);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.trigger === "manual" && r.fire_at.toISOString() === at)).toBe(true);
    expect(await usageOf(tenantId)).toHaveLength(2);
    expect(await auditOf(tenantId)).toHaveLength(2);
    expect(await lastFireOf(aopId, tenantId)).toBeNull();
  });

  it("disparo agendado vencido antes de um manual ainda roda no tick seguinte", async () => {
    const { tenantId } = await tenantWith(["a1"]);
    const aopId = await aopFor(tenantId, ["a1"], ["insight"]);
    await job.handle(manual(tenantId, aopId, "2026-11-27T12:01:00.000Z"));

    expect((await job.runOnce({ onlyTenants: [tenantId] })).fired).toBe(1);
    const runs = await runsOf(tenantId);
    expect(runs.map((r) => [r.trigger, r.fire_at.toISOString()])).toEqual([
      ["manual", "2026-11-27T12:01:00.000Z"],
      ["schedule", FIRE_0900],
    ]);
    expect(await usageOf(tenantId)).toHaveLength(2);
  });

  it("cota esgotada no meio: os seguintes ficam skipped/quota_exceeded, sem cobrança", async () => {
    const { tenantId, clients } = await tenantWith(["a1", "a2", "a3"], 1);
    await aopFor(tenantId, ["a1", "a2", "a3"], ["insight"]);

    expect((await job.runOnce({ onlyTenants: [tenantId] })).fired).toBe(1);
    const runs = await runsOf(tenantId);
    const byClient = Object.fromEntries(runs.map((r) => [r.client_id, r]));
    expect(byClient[must(clients["a1"])]).toMatchObject({ status: "ok", work_type: "analysis" });
    for (const ext of ["a2", "a3"]) {
      expect(byClient[must(clients[ext])]).toMatchObject({
        status: "skipped",
        failure_code: "quota_exceeded",
        work_type: null,
        price_brl: null,
        audit_id: null,
      });
    }
    expect((await usageOf(tenantId)).map((u) => u.client_id)).toEqual([clients["a1"]]);
  });

  it("cliente removido depois de criar o AOP: sem execução nem cobrança dele; os outros rodam", async () => {
    const { tenantId, clients } = await tenantWith(["a1"]);
    await aopFor(tenantId, ["sumiu", "a1"], ["insight"]);

    expect((await job.runOnce({ onlyTenants: [tenantId] })).fired).toBe(1);
    expect((await runsOf(tenantId)).map((r) => [r.client_id, r.status])).toEqual([
      [clients["a1"], "ok"],
    ]);
    expect((await usageOf(tenantId)).map((u) => u.client_id)).toEqual([clients["a1"]]);
    expect(logged).toContainEqual(expect.objectContaining({ msg: "AOP executado", skipped: 1 }));
  });
});
