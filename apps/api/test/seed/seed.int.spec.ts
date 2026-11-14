/**
 * Seed de demo (`pnpm --filter @carina/api seed`): idempotente, cria o tenant `demo` e as duas
 * chaves com o papel migrator, e os três clientes sintéticos pela ingestão + Sync.
 *
 * Redis: DB lógico próprio (test/setup/redis-dbs.ts), esvaziado a cada teste. O banco é o da execução (global-setup); o tenant
 * `demo` só é criado aqui, então as contagens filtram por ele.
 */
import http from "node:http";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ChatModule } from "../../src/modules/chat/chat.module.js";
import { hashApiKey } from "../../src/modules/tenancy/api-key.js";
import {
  DEFAULT_DEMO_APP_KEY,
  DEFAULT_DEMO_APPROVER_KEY,
  DEMO_CLIENTS,
  DEMO_TENANT,
  SeedRefusedError,
  seed,
  type SeedLogger,
} from "../../src/seed/seed.js";
import { createTestApp, type TestApp } from "../setup/app.js";
import { appUrl, migratorSql, migratorUrl, must, redisDbUrl } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

const REDIS_DB = redisDbOf("seed/seed.int.spec.ts");

function seedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: appUrl(),
    MIGRATION_DATABASE_URL: migratorUrl(),
    REDIS_URL: redisDbUrl(REDIS_DB),
    LLM_MODE: "mock",
    MARKET_MODE: "mock",
    LOG_LEVEL: "silent",
    DEMO_APP_KEY: "",
    DEMO_APPROVER_KEY: "",
    SEED_ALLOW_DEMO_KEYS: "",
    ...extra,
  };
}

/** Logger que guarda tudo o que o seed registrou (para provar que nenhuma chave vaza). */
function captureLogger(): SeedLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (o: unknown) => lines.push(JSON.stringify(o));
  return { lines, info: push, warn: push };
}

/** O tenant do seed (id fixo); homônimos "demo" de outra origem não contam. */
async function demoTenantIds(): Promise<string[]> {
  const rows = await migratorSql<{ id: string }>(`SELECT id FROM tenant WHERE id = $1`, [
    DEMO_TENANT.id,
  ]);
  return rows.map((r) => r.id);
}

describe("seed de demo", () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(redisDbUrl(REDIS_DB));
  });

  afterAll(async () => {
    await redis?.quit();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  it("as chaves padrão têm o formato das chaves geradas (sk-live- + 32 base62)", () => {
    for (const k of [DEFAULT_DEMO_APP_KEY, DEFAULT_DEMO_APPROVER_KEY]) {
      expect(k).toMatch(/^sk-live-[0-9A-Za-z]{32}$/);
    }
    expect(DEMO_CLIENTS.map((c) => c.externalId)).toEqual([
      "cliente-conservador",
      "cliente-moderado",
      "cliente-arrojado",
    ]);
  });

  describe("rodando duas vezes", () => {
    let tenantId: string;
    let homonymId: string;
    const logs = captureLogger();

    beforeAll(async () => {
      // Um tenant "demo" que NÃO é o do seed (nome não é único), suspenso e com outro plano.
      const [homonym] = await migratorSql<{ id: string }>(
        `INSERT INTO tenant (name, plan, rpm, monthly_quota, suspended_at)
         VALUES ('demo', 'outro', 7, 3, now()) RETURNING id`,
      );
      homonymId = must(homonym).id;
      await seed({ env: seedEnv(), logger: logs });
      await redis.flushdb();
      const second = await seed({ env: seedEnv(), logger: logs });
      tenantId = second.tenantId;
    }, 120_000);

    it("acha o tenant pelo id fixo: um homônimo 'demo' fica intocado (suspenso, sem chaves)", async () => {
      expect(tenantId).toBe(DEMO_TENANT.id);
      const [homonym] = await migratorSql<{
        plan: string;
        rpm: number;
        suspended: boolean;
        keys: number;
      }>(
        `SELECT plan, rpm, suspended_at IS NOT NULL AS suspended,
           (SELECT count(*)::int FROM api_key WHERE tenant_id = tenant.id) AS keys
         FROM tenant WHERE id = $1`,
        [homonymId],
      );
      expect(homonym).toEqual({ plan: "outro", rpm: 7, suspended: true, keys: 0 });
    });

    it("reaplica plano e limites do PRÓPRIO tenant de demo, mas não mexe numa suspensão", async () => {
      await migratorSql(`UPDATE tenant SET suspended_at = now(), rpm = 1 WHERE id = $1`, [
        tenantId,
      ]);
      await redis.flushdb();
      const again = await seed({ env: seedEnv(), logger: captureLogger() });
      expect(again.tenantId).toBe(tenantId);
      expect(again.clients.every((c) => c.skipped)).toBe(true);
      const [t] = await migratorSql<{ rpm: number; suspended: boolean }>(
        `SELECT rpm, suspended_at IS NOT NULL AS suspended FROM tenant WHERE id = $1`,
        [tenantId],
      );
      // Suspensão é decisão de operação: rodar o seed de novo não a desfaz.
      expect(t).toEqual({ rpm: 120, suspended: true });
      await migratorSql(`UPDATE tenant SET suspended_at = NULL WHERE id = $1`, [tenantId]);
    }, 120_000);

    it("rodar o seed de novo reescopa uma chave existente (banco semeado antes ganha market:read)", async () => {
      await migratorSql(`UPDATE api_key SET scopes = $2::text[] WHERE hash = $1`, [
        hashApiKey(DEFAULT_DEMO_APP_KEY),
        ["chat", "data:write"],
      ]);
      await redis.flushdb();
      await seed({ env: seedEnv(), logger: captureLogger() });
      const [row] = await migratorSql<{ scopes: string[] }>(
        `SELECT scopes FROM api_key WHERE hash = $1`,
        [hashApiKey(DEFAULT_DEMO_APP_KEY)],
      );
      expect(must(row).scopes.sort()).toEqual(["chat", "data:write", "market:read"]);
    }, 120_000);

    it("deixa 1 tenant demo (rpm 120, cota 0), 2 chaves e 3 clientes", async () => {
      expect(await demoTenantIds()).toEqual([tenantId]);
      const [tenant] = await migratorSql<{ rpm: number; monthly_quota: number }>(
        `SELECT rpm, monthly_quota FROM tenant WHERE id = $1`,
        [tenantId],
      );
      expect(tenant).toEqual({ rpm: 120, monthly_quota: 0 });

      const keys = await migratorSql<{ hash: string; scopes: string[]; revoked: boolean }>(
        `SELECT hash, scopes, revoked_at IS NOT NULL AS revoked FROM api_key WHERE tenant_id = $1
         ORDER BY label`,
        [tenantId],
      );
      expect(keys).toHaveLength(2);
      const byHash = new Map(keys.map((k) => [k.hash, k]));
      expect(byHash.get(hashApiKey(DEFAULT_DEMO_APP_KEY))?.scopes.sort()).toEqual(
        ["chat", "data:write", "market:read"].sort(),
      );
      expect(byHash.get(hashApiKey(DEFAULT_DEMO_APPROVER_KEY))?.scopes.sort()).toEqual(
        ["chat", "inbox:decide"].sort(),
      );
      expect(keys.every((k) => !k.revoked)).toBe(true);

      const clients = await migratorSql<{ external_id: string }>(
        `SELECT external_id FROM client`,
        [],
        { tenantId },
      );
      expect(clients.map((c) => c.external_id).sort()).toEqual(
        ["cliente-arrojado", "cliente-conservador", "cliente-moderado"].sort(),
      );
    });

    it("cada cliente tem posições, transações e ≥ 2 documentos de conhecimento", async () => {
      const clients = await migratorSql<{ id: string; external_id: string }>(
        `SELECT id, external_id FROM client`,
        [],
        { tenantId },
      );
      for (const c of clients) {
        const ctx = { tenantId, clientId: c.id };
        const [pos] = await migratorSql<{ n: number }>(
          `SELECT count(*)::int AS n FROM position WHERE source = 'synthetic'`,
          [],
          ctx,
        );
        const [txs] = await migratorSql<{ n: number }>(
          `SELECT count(*)::int AS n FROM transaction WHERE source = 'synthetic'`,
          [],
          ctx,
        );
        const [docs] = await migratorSql<{ n: number }>(
          `SELECT count(*)::int AS n FROM kg_document`,
          [],
          ctx,
        );
        expect(must(pos).n, c.external_id).toBeGreaterThan(0);
        expect(must(txs).n, c.external_id).toBeGreaterThan(0);
        expect(must(docs).n, c.external_id).toBeGreaterThanOrEqual(2);
      }
    });

    it("nunca registra o valor das chaves (nem o prefixo) no log", () => {
      const all = logs.lines.join("\n");
      expect(logs.lines.length).toBeGreaterThan(0);
      for (const k of [DEFAULT_DEMO_APP_KEY, DEFAULT_DEMO_APPROVER_KEY]) {
        expect(all).not.toContain(k);
        expect(all).not.toContain(k.slice(0, 12));
        expect(all).not.toContain(hashApiKey(k));
      }
    });

    describe("chaves pela API real", () => {
      let t: TestApp;
      let server: http.Server;

      beforeAll(async () => {
        t = await createTestApp({ imports: [ChatModule], redisDb: REDIS_DB });
        server = t.app.getHttpServer() as http.Server;
      });

      afterAll(async () => {
        await t?.close();
      });

      it("a chave app autentica, lista os clientes e NÃO tem inbox:decide (403)", async () => {
        const list = await request(server)
          .get("/api/clients")
          .set("Authorization", `Bearer ${DEFAULT_DEMO_APP_KEY}`);
        expect(list.status).toBe(200);
        const decision = await request(server)
          .post("/api/inbox/00000000-0000-4000-8000-000000000000/decision")
          .set("Authorization", `Bearer ${DEFAULT_DEMO_APP_KEY}`)
          .send({ approved: true });
        expect(decision.status).toBe(403);
      });

      it("a chave aprovadora tem inbox:decide (passa do 403; aprovação inexistente → 404)", async () => {
        const decision = await request(server)
          .post("/api/inbox/00000000-0000-4000-8000-000000000000/decision")
          .set("Authorization", `Bearer ${DEFAULT_DEMO_APPROVER_KEY}`)
          .send({ approved: true });
        expect(decision.status).toBe(404);
      });
    });
  });

  describe("produção", () => {
    it("recusa as chaves fixas de demo com NODE_ENV=production sem a liberação explícita", async () => {
      const before = await demoTenantIds();
      await expect(seed({ env: seedEnv({ NODE_ENV: "production" }) })).rejects.toBeInstanceOf(
        SeedRefusedError,
      );
      // Uma só chave fixa também basta para recusar.
      await expect(
        seed({
          env: seedEnv({
            NODE_ENV: "production",
            DEMO_APP_KEY: "sk-live-0123456789abcdefghijABCDEFGHIJ01",
          }),
        }),
      ).rejects.toBeInstanceOf(SeedRefusedError);
      // Nada foi gravado pela tentativa recusada.
      expect(await demoTenantIds()).toEqual(before);
    });

    it("chave com formato inválido é recusada antes de tocar no banco", async () => {
      await expect(seed({ env: seedEnv({ DEMO_APP_KEY: "sk-live-curta" }) })).rejects.toThrow(
        /DEMO_APP_KEY/,
      );
    });

    it("sem MIGRATION_DATABASE_URL (opcional para a API) o seed para com erro claro", async () => {
      await expect(seed({ env: seedEnv({ MIGRATION_DATABASE_URL: "" }) })).rejects.toThrow(
        /MIGRATION_DATABASE_URL/,
      );
    });

    it("com SEED_ALLOW_DEMO_KEYS=true roda em produção (demo local via docker compose)", async () => {
      const r = await seed({
        env: seedEnv({ NODE_ENV: "production", SEED_ALLOW_DEMO_KEYS: "true" }),
        logger: captureLogger(),
      });
      expect(await demoTenantIds()).toEqual([r.tenantId]);
    }, 120_000);
  });
});
