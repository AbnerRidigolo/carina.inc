/**
 * Orquestrador com Nest, Postgres (PostgresSaver no schema `langgraph`, como carina_app) e Redis
 * reais, em LLM_MODE=mock: interrupt durável, retomada em outra instância (restart), execução no
 * máximo uma vez, rejeição e isolamento de threads entre tenants.
 */
import { randomUUID } from "node:crypto";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { ChatEvent } from "@carina/shared";
import type { Redis } from "ioredis";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import { NotFoundError } from "../../src/core/errors/domain-errors.js";
import { REDIS } from "../../src/core/redis/redis.module.js";
import { ExecutorRegistry } from "../../src/modules/inbox/executors.js";
import { InboxService } from "../../src/modules/inbox/inbox.service.js";
import {
  CHECKPOINT_MIGRATION_VERSION,
  CHECKPOINT_SCHEMA,
} from "../../src/modules/orchestrator/checkpointer.js";
import { OrchestratorModule } from "../../src/modules/orchestrator/orchestrator.module.js";
import { OrchestratorService } from "../../src/modules/orchestrator/orchestrator.service.js";
import { createTestApp, type TestApp } from "../setup/app.js";
import { appUrl, migratorSql, migratorUrl, must, withPgClient } from "../setup/db.js";

const REDIS_DB = 3;

interface Party {
  tenantId: string;
  clientId: string;
  by: Parameters<InboxService["decide"]>[2];
}

describe("Orquestrador (int)", () => {
  let t1: TestApp;
  let t2: TestApp;
  let redis: Redis;
  let A: Party;
  let B: Party;
  const placeTrade = vi.fn(async () => ({ orderId: "SIM-INT", status: "filled" }));

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
  const thread = (p: Party) => `${p.tenantId}:${p.clientId}:${randomUUID()}`;
  const svc = (t: TestApp) => t.app.get(OrchestratorService);

  async function turn(t: TestApp, p: Party, threadId: string, question: string) {
    const events: ChatEvent[] = [];
    await as(p, async () => {
      for await (const e of svc(t).stream({ threadId, question })) events.push(e);
    });
    return events;
  }

  const decide = (t: TestApp, p: Party, id: string, approved: boolean) =>
    TenantContext.run({ tenantId: p.tenantId }, () =>
      t.app.get(InboxService).decide(id, { approved }, p.by),
    );

  const approvals = (p: Party) =>
    migratorSql<{ id: string; status: string; thread_id: string }>(
      `SELECT id, status, thread_id FROM approval_request`,
      [],
      { tenantId: p.tenantId },
    );
  const executions = (p: Party, approvalId: string) =>
    migratorSql<{ status: string }>(
      `SELECT status FROM executed_action WHERE approval_request_id = $1`,
      [approvalId],
      { tenantId: p.tenantId },
    );

  beforeAll(async () => {
    t1 = await createTestApp({ imports: [OrchestratorModule], redisDb: REDIS_DB });
    redis = t1.app.get<Redis>(REDIS);
    A = await party(t1, "Orq A");
    B = await party(t1, "Orq B");
  });

  afterAll(async () => {
    await t2?.close();
    await t1?.close();
  });

  beforeEach(async () => {
    await redis.flushdb();
    placeTrade.mockClear();
    for (const t of [t1, t2]) {
      if (!t) continue;
      const reg = t.app.get(ExecutorRegistry);
      reg.resetDefaults();
      reg.register("place_trade", placeTrade);
    }
  });

  it("compra: approval_required, pendente, nada executado; restart retoma uma vez só", async () => {
    const threadId = thread(A);
    const events = await turn(t1, A, threadId, "compre 100 ações de PETR4");
    const last = events.at(-1);
    expect(last?.type).toBe("approval_required");
    const approvalId = last?.type === "approval_required" ? last.approval.id : "";

    const rows = await approvals(A);
    expect(rows).toEqual([{ id: approvalId, status: "pending", thread_id: threadId }]);
    expect(placeTrade).not.toHaveBeenCalled();
    expect(await executions(A, approvalId)).toHaveLength(0);

    // Checkpoint persistido no Postgres, com o thread prefixado pelo tenant e cliente.
    const cps = await migratorSql<{ n: string }>(
      `SELECT count(*)::text AS n FROM langgraph.checkpoints WHERE thread_id = $1`,
      [threadId],
    );
    expect(Number(must(cps[0]).n)).toBeGreaterThan(0);

    await decide(t1, A, approvalId, true);

    // "Restart": outra instância do app (outro OrchestratorService e outro pool) retoma.
    t2 = await createTestApp({ imports: [OrchestratorModule], redisDb: REDIS_DB });
    t2.app.get(ExecutorRegistry).register("place_trade", placeTrade);
    expect(svc(t2)).not.toBe(svc(t1));

    const out = await as(A, () => svc(t2).resume(threadId, true));
    expect(out.execution).toEqual({
      approvalId,
      status: "succeeded",
      result: { orderId: "SIM-INT", status: "filled" },
    });
    expect(placeTrade).toHaveBeenCalledTimes(1);

    const again = await as(A, () => svc(t1).resume(threadId, true));
    expect(again.execution).toMatchObject({ approvalId, status: "skipped" });
    expect(placeTrade).toHaveBeenCalledTimes(1);
    expect(await executions(A, approvalId)).toEqual([{ status: "succeeded" }]);

    const state = await as(A, () => svc(t1).finalState(threadId));
    expect(state.execution?.status).toBe("succeeded");
  });

  it("retomadas concorrentes (duas instâncias) executam no máximo uma vez", async () => {
    t2 ??= await createTestApp({ imports: [OrchestratorModule], redisDb: REDIS_DB });
    t2.app.get(ExecutorRegistry).register("place_trade", placeTrade);
    const threadId = thread(A);
    const events = await turn(t1, A, threadId, "compre 7 ações de VALE3");
    const last = events.at(-1);
    const approvalId = last?.type === "approval_required" ? last.approval.id : "";
    await decide(t1, A, approvalId, true);

    const results = await Promise.allSettled([
      as(A, () => svc(t1).resume(threadId, true)),
      as(A, () => svc(t2).resume(threadId, true)),
    ]);
    expect(placeTrade).toHaveBeenCalledTimes(1);
    const statuses = results.flatMap((r) =>
      r.status === "fulfilled" ? [r.value.execution.status] : [],
    );
    expect(statuses).toContain("succeeded");
    expect(await executions(A, approvalId)).toEqual([{ status: "succeeded" }]);
  });

  it("rejeitada: a retomada nunca executa", async () => {
    const threadId = thread(A);
    const events = await turn(t1, A, threadId, "compre 3 ações de ITUB4");
    const last = events.at(-1);
    const approvalId = last?.type === "approval_required" ? last.approval.id : "";
    await decide(t1, A, approvalId, false);

    const out = await as(A, () => svc(t1).resume(threadId, false));
    expect(out.execution).toEqual({ approvalId, status: "rejected" });
    // Mesmo uma retomada "aprovada" forjada depois não executa (thread já resolvido).
    const forged = await as(A, () => svc(t1).resume(threadId, true));
    expect(forged.execution.status).toBe("skipped");
    expect(placeTrade).not.toHaveBeenCalled();
    expect(await executions(A, approvalId)).toHaveLength(0);
  });

  it("retomada 'aprovada' sem aprovação no banco não executa (o banco decide)", async () => {
    const threadId = thread(B);
    const events = await turn(t1, B, threadId, "compre 5 ações de BBAS3");
    const last = events.at(-1);
    const approvalId = last?.type === "approval_required" ? last.approval.id : "";
    const out = await as(B, () => svc(t1).resume(threadId, true));
    expect(out.execution).toEqual({ approvalId, status: "skipped" });
    expect(placeTrade).not.toHaveBeenCalled();
    expect(await executions(B, approvalId)).toHaveLength(0);
    expect((await approvals(B)).find((r) => r.id === approvalId)?.status).toBe("pending");
  });

  it("outro tenant não retoma nem lê o thread", async () => {
    const threadId = thread(A);
    const events = await turn(t1, A, threadId, "compre 9 ações de WEGE3");
    const last = events.at(-1);
    const approvalId = last?.type === "approval_required" ? last.approval.id : "";
    await decide(t1, A, approvalId, true);

    await expect(as(B, () => svc(t1).resume(threadId, true))).rejects.toThrow(NotFoundError);
    await expect(as(B, () => svc(t1).finalState(threadId))).rejects.toThrow(NotFoundError);
    expect(placeTrade).not.toHaveBeenCalled();
    // O dono ainda retoma normalmente.
    const out = await as(A, () => svc(t1).resume(threadId, true));
    expect(out.execution.status).toBe("succeeded");
  });

  describe("checkpoint no Postgres", () => {
    it("carina_app grava e lê checkpoints, mas não cria objetos no schema langgraph", async () => {
      await withPgClient(appUrl(), async (c) => {
        const { rows } = await c.query<{ v: number }>(
          `SELECT max(v) AS v FROM ${CHECKPOINT_SCHEMA}.checkpoint_migrations`,
        );
        expect(rows[0]?.v).toBe(CHECKPOINT_MIGRATION_VERSION);
        await expect(c.query(`CREATE TABLE langgraph.x (id int)`)).rejects.toMatchObject({
          code: "42501",
        });
        await expect(
          c.query(`INSERT INTO langgraph.checkpoint_migrations (v) VALUES (99)`),
        ).rejects.toMatchObject({ code: "42501" });
      });
    });

    it("paridade: as tabelas da 0005 são as do setup() original da versão fixada", async () => {
      const schema = `lg_parity_${process.pid}`;
      const pool = new pg.Pool({ connectionString: migratorUrl(), max: 1 });
      try {
        await new PostgresSaver(pool, undefined, { schema }).setup();
        const describe = (s: string) =>
          migratorSql<{ t: string; c: string; ty: string; nn: string; d: string | null }>(
            `SELECT table_name AS t, column_name AS c, data_type AS ty, is_nullable AS nn,
                    column_default AS d
               FROM information_schema.columns WHERE table_schema = $1
              ORDER BY table_name COLLATE "C", ordinal_position`,
            [s],
          );
        const pks = (s: string) =>
          migratorSql<{ t: string; cols: string }>(
            `SELECT tc.table_name AS t,
                    string_agg(k.column_name, ',' ORDER BY k.ordinal_position) AS cols
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage k
                 ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema
              WHERE tc.table_schema = $1 AND tc.constraint_type = 'PRIMARY KEY'
              GROUP BY tc.table_name ORDER BY tc.table_name COLLATE "C"`,
            [s],
          );
        // A ordem das colunas de checkpoint_writes pode diferir (ALTER ADD COLUMN): compara por nome.
        const byName = (rows: { t: string; c: string }[]) =>
          [...rows].sort((a, b) => (`${a.t}.${a.c}` < `${b.t}.${b.c}` ? -1 : 1));
        expect(byName(await describe(CHECKPOINT_SCHEMA))).toEqual(byName(await describe(schema)));
        expect(await pks(CHECKPOINT_SCHEMA)).toEqual(await pks(schema));
        const versions = (s: string) =>
          migratorSql<{ v: number }>(`SELECT v FROM ${s}.checkpoint_migrations ORDER BY v`);
        expect(await versions(CHECKPOINT_SCHEMA)).toEqual(await versions(schema));
      } finally {
        await pool.end();
        await migratorSql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    });
  });
});
