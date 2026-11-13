import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { appUrl, inRlsTransaction, migratorSql, must, withPgClient } from "../setup/db.js";

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

  it("usage_record é append-only: INSERT funciona; UPDATE, DELETE e TRUNCATE dão permission denied", async () => {
    await asApp(async (c) => {
      await inRlsTransaction(c, { tenantId: tenantA }, () =>
        c.query(
          `INSERT INTO usage_record (tenant_id, work_type, price_brl, duration_ms) VALUES ($1, 'query', 1.50, 1)`,
          [tenantA],
        ),
      );
      for (const sql of [
        "UPDATE usage_record SET price_brl = 0",
        "DELETE FROM usage_record",
        "TRUNCATE usage_record",
      ]) {
        await expect(
          inRlsTransaction(c, { tenantId: tenantA }, () => c.query(sql)),
          sql,
        ).rejects.toThrow(/permission denied/);
      }
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

  it("resolve_api_key_by_id: chave ativa pelo id; revogada, inexistente ou de tenant suspenso → nada", async () => {
    const suspended = randomUUID();
    const suspendedHash = sha256(`sk-live-${randomUUID()}`);
    await migratorSql(
      `INSERT INTO tenant (id, name, plan, rpm, monthly_quota) VALUES ($1, 'Suspenso', 'pro', 60, 0)`,
      [suspended],
    );
    await migratorSql(
      `INSERT INTO api_key (tenant_id, hash, prefix, scopes) VALUES ($1, $2, 'sk-live-cccc', ARRAY['chat'])`,
      [suspended, suspendedHash],
    );
    const ids = await migratorSql<{ id: string; hash: string }>(
      `SELECT id, hash FROM api_key WHERE hash = ANY($1::text[])`,
      [[keyHash, revokedHash, suspendedHash]],
    );
    const idOf = (h: string) => ids.find((r) => r.hash === h)?.id;
    await asApp(async (c) => {
      const active = await c.query("SELECT * FROM resolve_api_key_by_id($1)", [idOf(keyHash)]);
      expect(active.rows).toHaveLength(1);
      expect(active.rows[0]).toMatchObject({ tenant_id: tenantA, rpm: 120, monthly_quota: 1000 });
      const revoked = await c.query("SELECT * FROM resolve_api_key_by_id($1)", [idOf(revokedHash)]);
      expect(revoked.rows).toHaveLength(0);
      const missing = await c.query("SELECT * FROM resolve_api_key_by_id($1)", [randomUUID()]);
      expect(missing.rows).toHaveLength(0);
      // Ainda não suspenso: as duas funções resolvem.
      expect(
        (await c.query("SELECT * FROM resolve_api_key($1)", [suspendedHash])).rows,
      ).toHaveLength(1);
    });
    await migratorSql(`UPDATE tenant SET suspended_at = now() WHERE id = $1`, [suspended]);
    await asApp(async (c) => {
      const byId = await c.query("SELECT * FROM resolve_api_key_by_id($1)", [idOf(suspendedHash)]);
      expect(byId.rows).toHaveLength(0);
      const byHash = await c.query("SELECT * FROM resolve_api_key($1)", [suspendedHash]);
      expect(byHash.rows).toHaveLength(0);
    });
  });

  it("resolve_api_key e resolve_api_key_by_id não são sombreadas por tabelas temporárias de carina_app", async () => {
    const forgedTenant = randomUUID();
    const forgedHash = sha256(`sk-live-${randomUUID()}`);
    const forgedKeyId = randomUUID();
    const [realKey] = await migratorSql<{ id: string }>(`SELECT id FROM api_key WHERE hash = $1`, [
      keyHash,
    ]);
    const realKeyId = must(realKey).id;
    await asApp(async (c) => {
      // carina_app tem TEMPORARY (via PUBLIC): tenta sombrear api_key e tenant com pg_temp.
      await c.query(`CREATE TEMP TABLE api_key (id uuid, tenant_id uuid, hash text, prefix text,
                       scopes text[], label text, revoked_at timestamptz, created_at timestamptz)`);
      await c.query(`CREATE TEMP TABLE tenant (id uuid, name text, plan text, rpm int,
                       monthly_quota int, created_at timestamptz)`);
      await c.query(`INSERT INTO pg_temp.tenant VALUES ($1, 'Forjado', 'pro', 9999, 0, now())`, [
        forgedTenant,
      ]);
      await c.query(
        `INSERT INTO pg_temp.api_key VALUES ($4, $1, $2, 'x', ARRAY['admin'], NULL, NULL, now()),
                                            ($5, $1, $3, 'x', ARRAY['admin'], NULL, NULL, now())`,
        [forgedTenant, forgedHash, keyHash, forgedKeyId, realKeyId],
      );
      // Dono das tabelas temporárias, o atacante libera a leitura para o definer da função.
      await c.query("GRANT SELECT ON pg_temp.api_key, pg_temp.tenant TO PUBLIC");

      const forged = await c.query("SELECT * FROM resolve_api_key($1)", [forgedHash]);
      expect(forged.rows).toHaveLength(0);

      const real = await c.query("SELECT * FROM resolve_api_key($1)", [keyHash]);
      expect(real.rows).toHaveLength(1);
      expect(real.rows[0]).toMatchObject({ tenant_id: tenantA, tenant_name: "Tenant A" });

      // Pelo id (revalidação dos sockets): a chave forjada não existe; a real volta com o tenant real.
      const forgedById = await c.query("SELECT * FROM resolve_api_key_by_id($1)", [forgedKeyId]);
      expect(forgedById.rows).toHaveLength(0);
      const realById = await c.query("SELECT * FROM resolve_api_key_by_id($1)", [realKeyId]);
      expect(realById.rows).toHaveLength(1);
      expect(realById.rows[0]).toMatchObject({ tenant_id: tenantA, tenant_name: "Tenant A" });
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
