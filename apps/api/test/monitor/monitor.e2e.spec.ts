import type http from "node:http";
import {
  type ChatEvent,
  ChatEventSchema,
  PortfolioAlertPageSchema,
  ProblemSchema,
  WsTicketSchema,
} from "@carina/shared";
import type { Redis } from "ioredis";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { REDIS } from "../../src/core/redis/redis.tokens.js";
import { ChatModule } from "../../src/modules/chat/chat.module.js";
import { MonitorModule } from "../../src/modules/monitor/monitor.module.js";
import { eventually } from "../chat/helpers.js";
import { createTestApp, type SeededTenant, type TestApp } from "../setup/app.js";
import { migratorSql, must } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

// DB lógico próprio (test/setup/redis-dbs.ts): este arquivo faz flushdb a cada teste.
const REDIS_DB = redisDbOf("monitor/monitor.e2e.spec.ts");

const PATH = "/api/clients/c1/alerts";

/** Ouvinte mínimo do WebSocket do chat: guarda os eventos já validados pelo schema. */
class Listener {
  readonly events: ChatEvent[] = [];
  readonly opened: Promise<void>;
  constructor(readonly ws: WebSocket) {
    ws.on("message", (data: Buffer) =>
      this.events.push(ChatEventSchema.parse(JSON.parse(data.toString()))),
    );
    this.opened = new Promise((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.on("error", () => undefined);
  }
}

describe("Monitor de carteira E2E: GET /api/clients/:clientId/alerts", () => {
  let t: TestApp;
  let server: http.Server;
  let redis: Redis;
  let A: SeededTenant;
  let B: SeededTenant;
  const listeners: Listener[] = [];

  beforeAll(async () => {
    t = await createTestApp({ imports: [ChatModule, MonitorModule], redisDb: REDIS_DB });
    server = t.app.getHttpServer() as http.Server;
    redis = t.app.get<Redis>(REDIS);
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(async () => {
    await redis.flushdb();
    A = await t.seedTenant({ name: "Mon A" });
    B = await t.seedTenant({ name: "Mon B" });
  });

  afterEach(() => {
    for (const l of listeners.splice(0)) l.ws.terminate();
  });

  const get = (path: string, key: string | undefined) =>
    request(server)
      .get(path)
      .set(key ? { "X-API-Key": key } : {});

  const expectProblem = (res: request.Response, status: number) => {
    expect(res.status).toBe(status);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    ProblemSchema.parse(res.body);
  };

  const newClient = async (tenantId: string, externalId: string): Promise<string> => {
    const id = crypto.randomUUID();
    await migratorSql(
      `INSERT INTO client (id, tenant_id, external_id) VALUES ($1, $2, $3)`,
      [id, tenantId, externalId],
      { tenantId },
    );
    return id;
  };

  /** Grava um alerta com `created_at` explícito (ordem determinística). */
  const newAlert = async (
    tenantId: string,
    clientId: string,
    assetCode: string,
    createdAt: string,
  ): Promise<void> => {
    await migratorSql(
      `INSERT INTO portfolio_alert
         (tenant_id, client_id, asset_code, direction, change_pct, price, trading_day, created_at)
       VALUES ($1, $2, $3, 'up', 5.2, 38.1, '2026-11-20', $4)`,
      [tenantId, clientId, assetCode, createdAt],
      { tenantId },
    );
  };

  const usageCount = async (tenantId: string) =>
    Number(
      (
        await migratorSql<{ n: string }>(
          `SELECT count(*)::text AS n FROM usage_record WHERE tenant_id = $1`,
          [tenantId],
        )
      )[0]?.n,
    );

  it("GET /alerts lista do mais novo, pagina com cursor", async () => {
    const c1 = await newClient(A.tenantId, "c1");
    await newAlert(A.tenantId, c1, "AAA1", "2026-11-20T15:00:00Z");
    await newAlert(A.tenantId, c1, "BBB2", "2026-11-20T16:00:00Z");
    await newAlert(A.tenantId, c1, "CCC3", "2026-11-20T17:00:00Z");

    const first = await get(`${PATH}?limit=2`, A.keys.chat);
    expect(first.status).toBe(200);
    const page1 = PortfolioAlertPageSchema.parse(first.body);
    expect(page1.items.map((a) => a.assetCode)).toEqual(["CCC3", "BBB2"]);
    expect(page1.nextCursor).not.toBeNull();

    const second = await get(
      `${PATH}?limit=2&cursor=${encodeURIComponent(must(page1.nextCursor))}`,
      A.keys.chat,
    );
    expect(second.status).toBe(200);
    const page2 = PortfolioAlertPageSchema.parse(second.body);
    expect(page2.items.map((a) => a.assetCode)).toEqual(["AAA1"]);
    expect(page2.nextCursor).toBeNull();

    // padrão de 20: traz os três de uma vez
    const all = PortfolioAlertPageSchema.parse((await get(PATH, A.keys.chat)).body);
    expect(all.items).toHaveLength(3);
    expect(await usageCount(A.tenantId)).toBe(0);
  });

  it("cliente sem alertas devolve página vazia", async () => {
    await newClient(A.tenantId, "c1");
    const res = await get(PATH, A.keys.chat);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it("cliente de outro tenant → 404", async () => {
    const c1 = await newClient(A.tenantId, "c1");
    await newAlert(A.tenantId, c1, "AAA1", "2026-11-20T15:00:00Z");
    expectProblem(await get(PATH, B.keys.chat), 404);
    expectProblem(await get("/api/clients/inexistente/alerts", A.keys.chat), 404);
  });

  it("chave sem escopo chat → 403; sem chave → 401", async () => {
    await newClient(A.tenantId, "c1");
    expectProblem(await get(PATH, A.keys.ingest), 403);
    expectProblem(await get(PATH, A.keys.market), 403);
    expectProblem(await get(PATH, undefined), 401);
  });

  it("limit 51 → 422; limit 0, não numérico e cursor inválido também", async () => {
    await newClient(A.tenantId, "c1");
    for (const q of ["limit=51", "limit=0", "limit=abc", "limit=", "cursor=%25%25", "cursor=abc"]) {
      expectProblem(await get(`${PATH}?${q}`, A.keys.chat), 422);
    }
    expect((await get(`${PATH}?limit=50`, A.keys.chat)).status).toBe(200);
    expect((await get(`${PATH}?limit=1`, A.keys.chat)).status).toBe(200);
  });

  describe("WebSocket", () => {
    const connect = async (key: string, clientId: string): Promise<Listener> => {
      const res = await request(server)
        .post("/api/ws/ticket")
        .set("Authorization", `Bearer ${key}`)
        .send({ clientId });
      expect(res.status).toBe(201);
      const { ticket } = WsTicketSchema.parse(res.body);
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("servidor sem porta");
      const l = new Listener(
        new WebSocket(`ws://127.0.0.1:${addr.port}/ws/chat?ticket=${ticket}`, { autoPong: true }),
      );
      listeners.push(l);
      await l.opened;
      return l;
    };

    const internalId = async (tenantId: string, externalId: string) =>
      must(
        (
          await migratorSql<{ id: string }>(
            `SELECT id FROM client WHERE external_id = $1`,
            [externalId],
            { tenantId },
          )
        )[0],
      ).id;

    it("recebe portfolio_alert do próprio cliente e não o de outro cliente/tenant", async () => {
      const a1 = await connect(A.keys.chat, "c1");
      const a2 = await connect(A.keys.chat, "c2");
      const b1 = await connect(B.keys.chat, "c1");
      const clientA1 = await internalId(A.tenantId, "c1");

      const alert = {
        id: crypto.randomUUID(),
        assetCode: "PETR4",
        direction: "up",
        changePct: "5.2",
        price: "38.1",
        tradingDay: "2026-11-20",
        createdAt: "2026-11-20T15:00:00.000Z",
      };
      await redis.xadd(
        "inbox.events",
        "*",
        "data",
        JSON.stringify({
          eventId: crypto.randomUUID(),
          type: "monitor.alert",
          tenantId: A.tenantId,
          clientId: clientA1,
          alert,
        }),
      );

      await eventually(() => a1.events.length > 0, 10_000, "portfolio_alert");
      expect(a1.events).toEqual([{ type: "portfolio_alert", alert }]);
      await new Promise((r) => setTimeout(r, 200));
      expect(a2.events).toEqual([]);
      expect(b1.events).toEqual([]);
    });
  });
});
