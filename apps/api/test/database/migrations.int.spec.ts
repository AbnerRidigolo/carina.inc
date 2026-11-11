import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { appUrl, inRlsTransaction, migratorSql, withPgClient } from "../setup/db.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const asApp = <T>(fn: (c: pg.Client) => Promise<T>) => withPgClient(appUrl(), fn);

describe("migrações: papéis, grants e RLS (conectado como carina_app)", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const clientA1 = randomUUID();
  const clientA2 = randomUUID();
  const entityA1 = randomUUID();
  const entityA2 = randomUUID();
  const keyHash = sha256(`sk-live-${randomUUID()}`);
  const revokedHash = sha256(`sk-live-${randomUUID()}`);

  beforeAll(async () => {
    await migratorSql(
      `INSERT INTO tenant (id, name, plan, rpm, monthly_quota)
       VALUES ($1, 'Tenant A', 'pro', 120, 1000), ($2, 'Tenant B', 'free', 60, 0)`,
      [tenantA, tenantB],
    );
    await migratorSql(
      `INSERT INTO api_key (tenant_id, hash, prefix, scopes, revoked_at)
       VALUES ($1, $2, 'sk-live-aaaa', ARRAY['chat','inbox:decide'], NULL),
              ($1, $3, 'sk-live-bbbb', ARRAY['chat'], now())`,
      [tenantA, keyHash, revokedHash],
    );
    await migratorSql(
      `INSERT INTO client (id, tenant_id, external_id) VALUES ($1, $3, 'a1'), ($2, $3, 'a2')`,
      [clientA1, clientA2, tenantA],
      { tenantId: tenantA },
    );
    await migratorSql(
      `INSERT INTO position (tenant_id, client_id, source, external_id, institution, kind,
                             asset_class, asset_code, name, quantity, value_brl, as_of)
       VALUES ($1, $2, 'synthetic', 'p1', 'XP', 'investment', 'stock', 'PETR4', 'Petrobras PN',
               100, 3850.25, current_date)`,
      [tenantA, clientA1],
      { tenantId: tenantA },
    );
    await migratorSql(
      `INSERT INTO kg_entity (id, tenant_id, client_id, type, name) VALUES ($1, $2, $3, 'asset', 'PETR4')`,
      [entityA1, tenantA, clientA1],
      { tenantId: tenantA, clientId: clientA1 },
    );
    await migratorSql(
      `INSERT INTO kg_entity (id, tenant_id, client_id, type, name) VALUES ($1, $2, $3, 'asset', 'VALE3')`,
      [entityA2, tenantA, clientA2],
      { tenantId: tenantA, clientId: clientA2 },
    );
  });

  it("SELECT em position sem app.tenant_id não devolve nada (falha fechada)", async () => {
    await asApp(async (c) => {
      const without = await c.query<{ n: string }>("SELECT count(*) AS n FROM position");
      expect(without.rows[0]?.n).toBe("0");

      // A linha existe: com o tenant fixado, aparece.
      const withTenant = await inRlsTransaction(c, { tenantId: tenantA }, () =>
        c.query<{ n: string }>("SELECT count(*) AS n FROM position"),
      );
      expect(withTenant.rows[0]?.n).toBe("1");

      // Outro tenant não vê.
      const other = await inRlsTransaction(c, { tenantId: tenantB }, () =>
        c.query<{ n: string }>("SELECT count(*) AS n FROM position"),
      );
      expect(other.rows[0]?.n).toBe("0");
    });
  });

  it("audit_event é append-only: INSERT funciona, UPDATE dá permission denied", async () => {
    await asApp(async (c) => {
      await inRlsTransaction(c, { tenantId: tenantA }, () =>
        c.query(`INSERT INTO audit_event (tenant_id, channel, query) VALUES ($1, 'chat', 'q')`, [
          tenantA,
        ]),
      );
      await expect(
        inRlsTransaction(c, { tenantId: tenantA }, () =>
          c.query("UPDATE audit_event SET query = 'x'"),
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("api_key é inacessível para carina_app", async () => {
    await asApp(async (c) => {
      await expect(c.query("SELECT * FROM api_key")).rejects.toThrow(/permission denied/);
    });
  });

  it("resolve_api_key devolve o tenant da chave ativa e ignora a revogada", async () => {
    await asApp(async (c) => {
      const { rows } = await c.query("SELECT * FROM resolve_api_key($1)", [keyHash]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenant_id: tenantA,
        tenant_name: "Tenant A",
        scopes: ["chat", "inbox:decide"],
        rpm: 120,
        monthly_quota: 1000,
      });
      expect(rows[0]?.key_id).toEqual(expect.any(String));

      const revoked = await c.query("SELECT * FROM resolve_api_key($1)", [revokedHash]);
      expect(revoked.rows).toHaveLength(0);
    });
  });

  it("toda tabela de dados tem RLS com FORCE e política (guarda para tabelas futuras)", async () => {
    const tables = await migratorSql<{
      relname: string;
      rls: boolean;
      force: boolean;
      policies: string;
    }>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND c.relname NOT IN ('_prisma_migrations', 'tenant', 'api_key')
       ORDER BY c.relname`,
    );
    expect(tables.map((t) => t.relname)).toEqual([
      "approval_request",
      "audit_event",
      "client",
      "executed_action",
      "import_job",
      "kg_chunk",
      "kg_document",
      "kg_entity",
      "kg_mention",
      "kg_relation",
      "position",
      "transaction",
      "usage_record",
    ]);
    for (const t of tables) {
      expect({
        table: t.relname,
        rls: t.rls,
        force: t.force,
        hasPolicy: Number(t.policies) > 0,
      }).toEqual({ table: t.relname, rls: true, force: true, hasPolicy: true });
    }
  });

  it("kg_relation não aceita entidade de outro cliente (FK composta)", async () => {
    await asApp(async (c) => {
      const insert = (sourceId: string) =>
        inRlsTransaction(c, { tenantId: tenantA, clientId: clientA1 }, () =>
          c.query(
            `INSERT INTO kg_relation (tenant_id, client_id, source_id, target_id, type)
             VALUES ($1, $2, $3, $4, 'related_to')`,
            [tenantA, clientA1, sourceId, entityA1],
          ),
        );

      await expect(insert(entityA2)).rejects.toMatchObject({
        code: "23503", // foreign_key_violation
        message: expect.stringMatching(/foreign key/),
      });
      // Controle: com a entidade do próprio cliente, a inserção passa.
      await expect(insert(entityA1)).resolves.toBeDefined();
    });
  });
});
