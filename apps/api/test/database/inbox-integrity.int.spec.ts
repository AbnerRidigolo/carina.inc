/**
 * Migrações 0003 (FKs compostas da inbox) e 0004 (active_tenant_ids), provadas no banco:
 * as violações são recusadas pelo próprio Postgres (SQLSTATE 23503), não pela aplicação.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { appUrl, migratorSql, must, withPgClient } from "../setup/db.js";

const asApp = <T>(fn: (c: pg.Client) => Promise<T>) => withPgClient(appUrl(), fn);
// As linhas "vivas" têm prazos a 1000 dias: o ReconciliationJob dos outros arquivos (mesmo banco) não
// as expira nem as marca como needs_review enquanto este teste confere a função.
const hex = () => randomUUID().replaceAll("-", "").repeat(2);

async function seedTenant(
  name: string,
): Promise<{ tenantId: string; clientId: string; keyId: string }> {
  const [t] = await migratorSql<{ id: string }>(
    `INSERT INTO tenant (name, plan) VALUES ($1, 'pro') RETURNING id`,
    [name],
  );
  const tenantId = must(t).id;
  const [c] = await migratorSql<{ id: string }>(
    `INSERT INTO client (tenant_id, external_id) VALUES ($1, 'c1') RETURNING id`,
    [tenantId],
    { tenantId },
  );
  const [k] = await migratorSql<{ id: string }>(
    `INSERT INTO api_key (tenant_id, hash, prefix, scopes) VALUES ($1, $2, 'sk-live-xxxx', ARRAY['inbox:decide']) RETURNING id`,
    [tenantId, hex()],
  );
  return { tenantId, clientId: must(c).id, keyId: must(k).id };
}

async function insertApproval(
  s: { tenantId: string; clientId: string },
  status: string,
  opts: { decidedBy?: string | null } = {},
): Promise<string> {
  const id = hex();
  await migratorSql(
    `INSERT INTO approval_request (id, tenant_id, client_id, thread_id, agent, action, risk, payload,
       status, expires_at, decided_by_key_id)
     VALUES ($1, $2, $3, 't', 'executor', 'place_trade', 'irreversible', '{}'::jsonb, $4,
       now() + interval '1000 days', $5)`,
    [id, s.tenantId, s.clientId, status, opts.decidedBy ?? null],
    { tenantId: s.tenantId },
  );
  return id;
}

async function sqlState(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe("0003: FKs compostas da inbox", () => {
  let A: Awaited<ReturnType<typeof seedTenant>>;
  let B: Awaited<ReturnType<typeof seedTenant>>;

  beforeAll(async () => {
    A = await seedTenant("A");
    B = await seedTenant("B");
  });

  it("decided_by_key_id de outro tenant é recusado (23503); da chave do próprio tenant e NULL passam", async () => {
    const id = await insertApproval(A, "pending");
    const update = (key: string | null) =>
      migratorSql(`UPDATE approval_request SET decided_by_key_id = $2 WHERE id = $1`, [id, key], {
        tenantId: A.tenantId,
      });
    expect(await sqlState(update(B.keyId))).toBe("23503");
    expect(await sqlState(update(A.keyId))).toBeUndefined();
    expect(await sqlState(update(null))).toBeUndefined();
    // Também no INSERT.
    expect(await sqlState(insertApproval(A, "approved", { decidedBy: B.keyId }))).toBe("23503");
  });

  it("revogar a chave (DELETE) anula só decided_by_key_id e preserva o tenant_id", async () => {
    const own = await seedTenant("D");
    const id = await insertApproval(own, "approved", { decidedBy: own.keyId });
    await migratorSql(`DELETE FROM api_key WHERE id = $1`, [own.keyId]);
    const [row] = await migratorSql<{ decided_by_key_id: string | null; tenant_id: string }>(
      `SELECT decided_by_key_id, tenant_id FROM approval_request WHERE id = $1`,
      [id],
      { tenantId: own.tenantId },
    );
    expect(row).toEqual({ decided_by_key_id: null, tenant_id: own.tenantId });
  });

  it("executed_action com tenant/cliente diferente do da aprovação é recusado (23503)", async () => {
    const id = await insertApproval(A, "approved");
    const insert = (s: { tenantId: string; clientId: string }) =>
      migratorSql(
        `INSERT INTO executed_action (approval_request_id, tenant_id, client_id, status)
         VALUES ($1, $2, $3, 'started')`,
        [id, s.tenantId, s.clientId],
        { tenantId: s.tenantId },
      );
    // Tenant e cliente de B apontando para a aprovação de A: o cliente de B existe, a aprovação
    // existe, mas (tenant, cliente, aprovação) não bate com a aprovação.
    expect(await sqlState(insert(B))).toBe("23503");
    // Mesmo tenant, outro cliente.
    const [other] = await migratorSql<{ id: string }>(
      `INSERT INTO client (tenant_id, external_id) VALUES ($1, 'c2') RETURNING id`,
      [A.tenantId],
      { tenantId: A.tenantId },
    );
    expect(await sqlState(insert({ tenantId: A.tenantId, clientId: must(other).id }))).toBe(
      "23503",
    );
    // Os dados corretos passam.
    expect(await sqlState(insert(A))).toBeUndefined();
  });

  it("apagar a aprovação apaga o executed_action (CASCADE)", async () => {
    const id = await insertApproval(A, "approved");
    await migratorSql(
      `INSERT INTO executed_action (approval_request_id, tenant_id, client_id, status) VALUES ($1, $2, $3, 'started')`,
      [id, A.tenantId, A.clientId],
      { tenantId: A.tenantId },
    );
    await migratorSql(`DELETE FROM approval_request WHERE id = $1`, [id], { tenantId: A.tenantId });
    const rows = await migratorSql(
      `SELECT 1 FROM executed_action WHERE approval_request_id = $1`,
      [id],
      {
        tenantId: A.tenantId,
      },
    );
    expect(rows).toEqual([]);
  });
});

describe("0004: active_tenant_ids() (SECURITY DEFINER)", () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const mk = async (name: string) => {
      const s = await seedTenant(name);
      ids[name] = s.tenantId;
      return s;
    };
    const exec = (s: { tenantId: string; clientId: string }, approval: string, status: string) =>
      migratorSql(
        `INSERT INTO executed_action (approval_request_id, tenant_id, client_id, status, started_at)
         VALUES ($1, $2, $3, $4, now() + interval '1000 days')`,
        [approval, s.tenantId, s.clientId, status],
        { tenantId: s.tenantId },
      );
    // pending
    await insertApproval(await mk("pending"), "pending");
    // approved sem execução
    await insertApproval(await mk("approvedNoExec"), "approved");
    // started
    const started = await mk("started");
    await exec(started, await insertApproval(started, "approved"), "started");
    // terminais
    const done = await mk("terminal");
    await insertApproval(done, "rejected");
    await insertApproval(done, "expired");
    await exec(done, await insertApproval(done, "approved"), "succeeded");
    await exec(done, await insertApproval(done, "approved"), "failed");
    await exec(done, await insertApproval(done, "approved"), "needs_review");
    // sem nada
    await mk("empty");
  });

  const call = (c: pg.Client) =>
    c.query<{ active_tenant_ids: string }>("SELECT active_tenant_ids()");

  it("devolve só tenants com linha não terminal", async () => {
    const rows = await asApp(call);
    const got = new Set(rows.rows.map((r) => r.active_tenant_ids));
    expect(got.has(must(ids["pending"]))).toBe(true);
    expect(got.has(must(ids["approvedNoExec"]))).toBe(true);
    expect(got.has(must(ids["started"]))).toBe(true);
    expect(got.has(must(ids["terminal"]))).toBe(false);
    expect(got.has(must(ids["empty"]))).toBe(false);
    // sem duplicatas
    expect(got.size).toBe(rows.rows.length);
  });

  it("expõe só uma coluna uuid (nenhum outro dado) e nada além da função", async () => {
    await asApp(async (c) => {
      const r = await c.query("SELECT * FROM active_tenant_ids()");
      expect(r.fields.map((f) => f.name)).toEqual(["active_tenant_ids"]);
      // A função não abre as tabelas: o carina_app continua sem ver nenhuma linha sem contexto.
      const direct = await c.query<{ n: string }>("SELECT count(*) AS n FROM approval_request");
      expect(direct.rows[0]?.n).toBe("0");
      const direct2 = await c.query<{ n: string }>("SELECT count(*) AS n FROM executed_action");
      expect(direct2.rows[0]?.n).toBe("0");
    });
  });

  it("tabelas temporárias de carina_app não sombreiam as tabelas da função", async () => {
    await asApp(async (c) => {
      const forged = randomUUID();
      await c.query("SET search_path = pg_temp, public");
      await c.query(
        "CREATE TEMP TABLE approval_request (id text, tenant_id uuid, status text, expires_at timestamptz)",
      );
      await c.query(
        "CREATE TEMP TABLE executed_action (approval_request_id text, tenant_id uuid, status text)",
      );
      await c.query("INSERT INTO approval_request VALUES ('x', $1, 'pending', now())", [forged]);
      await c.query("INSERT INTO executed_action VALUES ('x', $1, 'started')", [forged]);
      const r = await call(c);
      const got = r.rows.map((x) => x.active_tenant_ids);
      expect(got).not.toContain(forged);
      expect(got).toContain(ids["pending"]);
    });
  });

  it("é SECURITY DEFINER do migrator, com search_path fixo (pg_temp por último) e sem EXECUTE para PUBLIC", async () => {
    const [fn] = await migratorSql<{
      secdef: boolean;
      owner: string;
      cfg: string[];
      acl: string;
      app_exec: boolean;
    }>(
      `SELECT p.prosecdef AS secdef, r.rolname AS owner, p.proconfig AS cfg, p.proacl::text AS acl,
              has_function_privilege('carina_app', p.oid, 'EXECUTE') AS app_exec
       FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.proname = 'active_tenant_ids'`,
    );
    expect(fn?.secdef).toBe(true);
    expect(fn?.owner).toBe("carina_migrator");
    expect(fn?.cfg).toContain("search_path=public, pg_temp");
    expect(fn?.app_exec).toBe(true);
    expect(fn?.acl).not.toMatch(/(^|[{,])=X\//);
  });
});
