/**
 * Boot REAL da API: `createApiApp()` é o mesmo bootstrap do main.ts (AppModule de produção, pino,
 * body parser de 5 MB, adaptador `ws`, prefixo `/api`, CORS, ProblemDetailsFilter). Prova:
 * - `/api/health` e `/api/ready` públicos, fora do rate limit e fora do log de requisições;
 * - a fiação do bootstrap (limite de corpo, CORS restrito ao WEB_ORIGIN, filtro global, logger do
 *   Nest apontado para o pino, WebSocket do chat atendendo na mesma porta);
 * - os logs de requisição levam tenantId/keyId e nunca a chave, o ticket nem a query string.
 *
 * Redis: DB lógico 0, esvaziado a cada teste. O ConfigModule do app lê `process.env` (como em
 * produção): o teste fixa as variáveis antes do boot e as restaura no fim.
 */
import type http from "node:http";
import { Writable } from "node:stream";
import { WsTicketSchema, type ChatEvent } from "@carina/shared";
import { Logger, type INestApplication } from "@nestjs/common";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApiApp } from "../../src/bootstrap.js";
import { generateApiKey } from "../../src/modules/tenancy/api-key.js";
import { appUrl, migratorSql, migratorUrl, must, redisDbUrl } from "../setup/db.js";

const REDIS_DB = 0;
const WEB_ORIGIN = "http://localhost:5173";

interface LogRecord {
  msg?: string;
  context?: string;
  tenantId?: string;
  keyId?: string;
  req?: { url?: string; query?: unknown; headers?: Record<string, unknown> };
  [k: string]: unknown;
}

async function eventually(check: () => boolean, ms = 10_000, what = "condição"): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Tempo esgotado esperando ${what}`);
}

describe("boot da API (createApiApp)", () => {
  const saved = { ...process.env };
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(...chunk.toString().split("\n").filter(Boolean));
      cb();
    },
  });
  const records = () => lines.map((l) => JSON.parse(l) as LogRecord);

  let app: INestApplication;
  let server: http.Server;
  let redis: Redis;
  let tenantId: string;
  let keyId: string;
  let key: string;
  /** Chave de outro tenant com rpm 1 (prova que health/ready ficam fora do rate limit). */
  let rpm1Key: string;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: "test",
      DATABASE_URL: appUrl(),
      MIGRATION_DATABASE_URL: migratorUrl(),
      REDIS_URL: redisDbUrl(REDIS_DB),
      LLM_MODE: "mock",
      WORKERS_ENABLED: "false",
      LOG_LEVEL: "info",
      WEB_ORIGIN,
    });
    app = await createApiApp({ logDestination: destination });
    await app.listen(0, "127.0.0.1");
    server = app.getHttpServer() as http.Server;
    redis = new Redis(redisDbUrl(REDIS_DB));

    const createTenant = async (name: string, rpm: number) => {
      const [tenant] = await migratorSql<{ id: string }>(
        `INSERT INTO tenant (name, plan, rpm, monthly_quota) VALUES ($1, 'pro', $2, 0) RETURNING id`,
        [name, rpm],
      );
      const id = must(tenant).id;
      const generated = generateApiKey();
      const [row] = await migratorSql<{ id: string }>(
        `INSERT INTO api_key (tenant_id, hash, prefix, scopes) VALUES ($1, $2, $3, $4) RETURNING id`,
        [id, generated.hash, generated.prefix, ["chat", "data:write"]],
      );
      return { tenantId: id, keyId: must(row).id, key: generated.key };
    };
    ({ tenantId, keyId, key } = await createTenant("Boot", 1000));
    rpm1Key = (await createTenant("Boot rpm 1", 1)).key;
  });

  afterAll(async () => {
    await app?.close();
    await redis?.quit();
    process.env = saved;
  });

  beforeEach(async () => {
    await redis.flushdb();
    lines.length = 0;
  });

  describe("health e ready", () => {
    it("GET /api/health → 200 { status: 'ok' } sem chave", async () => {
      const res = await request(server).get("/api/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok" });
    });

    it("GET /api/ready → 200 com Postgres e Redis ok", async () => {
      const res = await request(server).get("/api/ready");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ postgres: "ok", redis: "ok" });
    });

    it("ficam fora do rate limit mesmo com a chave de um tenant de rpm 1", async () => {
      for (let i = 0; i < 3; i++) {
        for (const path of ["/api/health", "/api/ready"]) {
          const res = await request(server).get(path).set("Authorization", `Bearer ${rpm1Key}`);
          expect(res.status, `${path} #${i}`).toBe(200);
        }
      }
      // Uma rota protegida do mesmo tenant: a 1ª passa, a 2ª estoura o rpm 1.
      const first = await request(server)
        .get("/api/clients")
        .set("Authorization", `Bearer ${rpm1Key}`);
      const second = await request(server)
        .get("/api/clients")
        .set("Authorization", `Bearer ${rpm1Key}`);
      expect([first.status, second.status]).toEqual([200, 429]);
    });

    it("health e ready não entram no log de requisições", async () => {
      await request(server).get("/api/health");
      await request(server).get("/api/ready");
      expect(records().filter((r) => r.req !== undefined)).toEqual([]);
    });
  });

  describe("fiação do bootstrap", () => {
    it("corpo JSON de ~1 MB passa do body parser (5 MB) e chega ao guard: 401, não 413", async () => {
      const items = Array.from({ length: 4000 }, (_, i) => ({
        externalId: `p${i}`,
        filler: "x".repeat(240),
      }));
      const res = await request(server).post("/api/clients/c1/positions").send({ items });
      expect(JSON.stringify({ items }).length).toBeGreaterThan(1_000_000);
      expect(res.status).toBe(401);
    });

    it("corpo acima de 5 MB → 413", async () => {
      const res = await request(server)
        .post("/api/clients/c1/positions")
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ blob: "x".repeat(6 * 1024 * 1024) }));
      expect(res.status).toBe(413);
    });

    it("CORS: só o WEB_ORIGIN recebe Access-Control-Allow-Origin (sem curinga)", async () => {
      const ok = await request(server)
        .options("/api/chat")
        .set("Origin", WEB_ORIGIN)
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", "authorization,content-type");
      expect(ok.status).toBe(204);
      expect(ok.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
      expect(ok.headers["access-control-allow-credentials"]).toBeUndefined();

      const evil = await request(server)
        .options("/api/chat")
        .set("Origin", "https://evil.example")
        .set("Access-Control-Request-Method", "POST");
      expect(evil.headers["access-control-allow-origin"]).toBeUndefined();

      const simple = await request(server).get("/api/health").set("Origin", WEB_ORIGIN);
      expect(simple.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
      expect(String(simple.headers["access-control-expose-headers"])).toMatch(/retry-after/i);
    });

    it("prefixo /api e ProblemDetailsFilter global: rota inexistente → 404 problem+json", async () => {
      const res = await request(server).get("/api/nao-existe");
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
      expect((await request(server).get("/health")).status).toBe(404);
    });

    it("o Logger do Nest escreve pelo pino (useLogger + bufferLogs)", async () => {
      new Logger("BootTest").log({ msg: "olá do Nest", probe: 42 });
      await eventually(() => records().some((r) => r.probe === 42), 2000, "log do Nest");
      expect(records().find((r) => r.probe === 42)).toMatchObject({
        context: "BootTest",
        msg: "olá do Nest",
      });
    });

    it("WebSocket do chat atende na mesma porta: ticket → conexão → turno até o done", async () => {
      const ticketRes = await request(server)
        .post("/api/ws/ticket")
        .set("Authorization", `Bearer ${key}`)
        .send({ clientId: "cli-boot" });
      expect(ticketRes.status).toBe(201);
      const { ticket } = WsTicketSchema.parse(ticketRes.body);

      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("servidor sem porta");
      const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/chat?ticket=${ticket}`);
      const events: ChatEvent[] = [];
      ws.on("message", (d: Buffer) => events.push(JSON.parse(d.toString()) as ChatEvent));
      try {
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", reject);
        });
        ws.send(JSON.stringify({ clientId: "cli-boot", message: "Como está minha carteira?" }));
        await eventually(
          () => events.some((e) => e.type === "done" || e.type === "error"),
          15_000,
          "fim do turno",
        );
        expect(events.at(-1)?.type).toBe("done");
      } finally {
        ws.terminate();
      }

      // O ticket viaja na query da URL do upgrade: nunca pode aparecer no log.
      expect(lines.join("\n")).not.toContain(ticket);
    });
  });

  describe("logs de requisição", () => {
    it("levam tenantId e keyId; nunca a chave, o header Authorization nem a query string", async () => {
      const secret = "SEGREDO-NA-QUERY-123";
      const res = await request(server)
        .get(`/api/clients?ticket=${secret}&token=${secret}`)
        .set("Authorization", `Bearer ${key}`)
        .set("X-Api-Key", key)
        .set("Cookie", `sid=${secret}`);
      expect(res.status).toBe(200);

      await eventually(() => records().some((r) => r.req?.url === "/api/clients"), 2000, "log");
      const line = must(records().find((r) => r.req?.url === "/api/clients"));
      expect(line).toMatchObject({ tenantId, keyId });
      expect(line.req?.query).toBeUndefined();
      expect(line.req?.headers?.["authorization"]).toBe("[REDACTED]");
      expect(line.req?.headers?.["x-api-key"]).toBe("[REDACTED]");
      expect(line.req?.headers?.["cookie"]).toBe("[REDACTED]");

      const all = lines.join("\n");
      expect(all).not.toContain(key);
      expect(all).not.toContain(key.slice(8));
      expect(all).not.toContain(secret);
    });

    it("requisição sem chave (401) não tem tenantId/keyId e também não vaza a query", async () => {
      const res = await request(server).get("/api/clients?ticket=abc-ticket-xyz");
      expect(res.status).toBe(401);
      await eventually(() => records().some((r) => r.req?.url === "/api/clients"), 2000, "log");
      const line = must(records().find((r) => r.req?.url === "/api/clients"));
      expect(line.tenantId).toBeUndefined();
      expect(line.keyId).toBeUndefined();
      expect(lines.join("\n")).not.toContain("abc-ticket-xyz");
    });
  });
});
