import {
  NormalizedPositionSchema,
  NormalizedTransactionSchema,
  ProblemSchema,
  StreamEventSchema,
  type NormalizedPosition,
  type NormalizedTransaction,
} from "@carina/shared";
import type { Redis } from "ioredis";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { REDIS } from "../../src/core/redis/redis.tokens.js";
import { StreamsService } from "../../src/core/redis/streams.service.js";
import { BillingService } from "../../src/modules/billing/billing.service.js";
import { DataIngestionModule } from "../../src/modules/data-ingestion/data-ingestion.module.js";
import {
  INGESTION_LOGGER,
  type IngestionLogger,
} from "../../src/modules/data-ingestion/ingestion.service.js";
import { createTestApp, type SeededTenant, type TestApp } from "../setup/app.js";
import { migratorSql } from "../setup/db.js";

// DB lógico próprio (o knowledge.int.spec usa o 14 e este arquivo faz flushdb a cada teste).
const REDIS_DB = 15;

const pos = (externalId: string, o: Partial<NormalizedPosition> = {}): NormalizedPosition => ({
  externalId,
  institution: "XP",
  kind: "investment",
  assetClass: "acao",
  assetCode: "PETR4",
  name: `Ativo ${externalId}`,
  quantity: "100",
  valueBrl: "3500.50",
  asOf: "2026-11-10",
  ...o,
});

const txn = (
  externalId: string,
  o: Partial<NormalizedTransaction> = {},
): NormalizedTransaction => ({
  externalId,
  institution: "Itaú",
  account: "cc-1",
  date: "2026-10-15",
  description: `Lançamento ${externalId}`,
  amountBrl: "-120.30",
  kind: "debit",
  ...o,
});

describe("Ingestão de dados E2E: /api/clients/:clientId/{positions,transactions}", () => {
  let t: TestApp;
  let server: Parameters<typeof request>[0];
  let redis: Redis;
  let A: SeededTenant;
  let B: SeededTenant;

  beforeAll(async () => {
    t = await createTestApp({ imports: [DataIngestionModule], redisDb: REDIS_DB });
    server = t.app.getHttpServer() as Parameters<typeof request>[0];
    redis = t.app.get<Redis>(REDIS);
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(async () => {
    await redis.flushdb();
    A = await t.seedTenant({ name: "A" });
    B = await t.seedTenant({ name: "B" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const post = (path: string, key: string | undefined, body: unknown) =>
    request(server)
      .post(path)
      .set(key ? { "X-API-Key": key } : {})
      .send(body as object);
  const get = (path: string, key: string | undefined) =>
    request(server)
      .get(path)
      .set(key ? { "X-API-Key": key } : {});

  const expectProblem = (res: request.Response, status: number) => {
    expect(res.status).toBe(status);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    const problem = ProblemSchema.parse(res.body);
    expect(problem.status).toBe(status);
    return problem;
  };

  const usageRows = (tenantId: string) =>
    migratorSql<{ work_type: string; price_brl: string; client_id: string | null }>(
      `SELECT work_type, price_brl::text AS price_brl, client_id FROM usage_record
       WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
      { tenantId },
    );

  const jobEvents = async () => {
    const entries = await redis.xrange("jobs", "-", "+");
    return entries.map(([, fields]) => StreamEventSchema.parse(JSON.parse(fields[1] as string)));
  };

  const clientRowId = async (tenantId: string, externalId: string) => {
    const rows = await migratorSql<{ id: string }>(
      `SELECT id FROM client WHERE tenant_id = $1 AND external_id = $2`,
      [tenantId, externalId],
      { tenantId },
    );
    return rows[0]?.id;
  };

  const countRows = async (table: "position" | "transaction", tenantId: string) => {
    const rows = await migratorSql<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE tenant_id = $1`,
      [tenantId],
      { tenantId },
    );
    return Number(rows[0]?.n);
  };

  describe("POST positions", () => {
    it("o mesmo lote de 3 posições enviado duas vezes deixa 3 linhas", async () => {
      const items = [pos("p1"), pos("p2"), pos("p3")];
      const r1 = await post("/api/clients/c1/positions", A.keys.ingest, { items });
      const r2 = await post("/api/clients/c1/positions", A.keys.ingest, { items });
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      expect((r1.body as { upserted: number }).upserted).toBe(3);
      expect((r2.body as { upserted: number }).upserted).toBe(3);

      const res = await get("/api/clients/c1/positions", A.keys.chat).expect(200);
      expect((res.body as { positions: unknown[] }).positions.length).toBe(3);
      expect(await countRows("position", A.tenantId)).toBe(3);
    });

    it("lote com externalId repetido grava uma linha, com os dados do último item", async () => {
      const items = [
        pos("p1", { name: "primeiro", valueBrl: "1.00", quantity: "1" }),
        pos("p2"),
        pos("p1", { name: "último", valueBrl: "2.00", assetCode: undefined, quantity: undefined }),
      ];
      const res = await post("/api/clients/c1/positions", A.keys.ingest, { items });
      expect(res.status).toBe(201);
      expect((res.body as { upserted: number }).upserted).toBe(2);

      const list = (await get("/api/clients/c1/positions", A.keys.chat).expect(200)).body
        .positions as {
        externalId: string;
        name: string;
        valueBrl: string;
        quantity?: string;
        assetCode?: string;
      }[];
      expect(list.length).toBe(2);
      const p1 = list.find((p) => p.externalId === "p1");
      expect(p1?.name).toBe("último");
      expect(p1?.valueBrl).toBe("2.00");
      expect(p1).not.toHaveProperty("quantity");
      expect(p1).not.toHaveProperty("assetCode");
    });

    it("reenviar um item alterado atualiza a linha (o último envio vence)", async () => {
      await post("/api/clients/c1/positions", A.keys.ingest, {
        items: [pos("p1", { valueBrl: "10.00", quantity: "5" })],
      }).expect(201);
      await post("/api/clients/c1/positions", A.keys.ingest, {
        items: [pos("p1", { valueBrl: "20.00", quantity: undefined })],
      }).expect(201);
      const list = (await get("/api/clients/c1/positions", A.keys.chat).expect(200)).body
        .positions as {
        valueBrl: string;
        quantity?: string;
      }[];
      expect(list).toHaveLength(1);
      expect(list[0]?.valueBrl).toBe("20.00");
      expect(list[0]).not.toHaveProperty("quantity");
      const [{ updated_gt_created } = { updated_gt_created: false }] = await migratorSql<{
        updated_gt_created: boolean;
      }>(`SELECT updated_at > created_at AS updated_gt_created FROM position`, [], {
        tenantId: A.tenantId,
      });
      expect(updated_gt_created).toBe(true);
    });

    it("não toca nas linhas de outra fonte com o mesmo externalId", async () => {
      await post("/api/clients/c1/positions", A.keys.ingest, { items: [pos("p1")] }).expect(201);
      const clientId = await clientRowId(A.tenantId, "c1");
      await migratorSql(
        `INSERT INTO position (tenant_id, client_id, source, external_id, institution, kind,
           asset_class, name, value_brl, as_of)
         VALUES ($1, $2, 'synthetic', 'p1', 'XP', 'investment', 'acao', 'sintético', 1, current_date)`,
        [A.tenantId, clientId],
        { tenantId: A.tenantId },
      );
      await post("/api/clients/c1/positions", A.keys.ingest, {
        items: [pos("p1", { name: "novo" })],
      }).expect(201);
      const rows = await migratorSql<{ source: string; name: string }>(
        `SELECT source, name FROM position ORDER BY source`,
        [],
        { tenantId: A.tenantId },
      );
      expect(rows).toEqual([
        { source: "api", name: "novo" },
        { source: "synthetic", name: "sintético" },
      ]);
    });

    it('valueBrl "10.123" → 422 com detail citando items.0.valueBrl; nada é gravado nem cobrado', async () => {
      const res = await post("/api/clients/c1/positions", A.keys.ingest, {
        items: [pos("p1", { valueBrl: "10.123" })],
      });
      const problem = expectProblem(res, 422);
      expect(problem.detail).toContain("items.0.valueBrl");
      expect(await usageRows(A.tenantId)).toEqual([]);
      expect(await jobEvents()).toEqual([]);
      expect(await clientRowId(A.tenantId, "c1")).toBeUndefined();
    });

    it("o caminho do item inválido cita o índice dele (items.2.asOf)", async () => {
      const res = await post("/api/clients/c1/positions", A.keys.ingest, {
        items: [pos("p1"), pos("p2"), pos("p3", { asOf: "2026-02-30" })],
      });
      expect(expectProblem(res, 422).detail).toContain("items.2.asOf");
    });

    it("1.001 itens → 422; 0 itens → 422; corpo sem items → 422", async () => {
      const big = Array.from({ length: 1001 }, (_, i) => pos(`p${i}`));
      expect(
        expectProblem(await post("/api/clients/c1/positions", A.keys.ingest, { items: big }), 422)
          .detail,
      ).toContain("items");
      expectProblem(await post("/api/clients/c1/positions", A.keys.ingest, { items: [] }), 422);
      expectProblem(await post("/api/clients/c1/positions", A.keys.ingest, {}), 422);
      expect(await usageRows(A.tenantId)).toEqual([]);
    });

    it("1.000 itens passam (limite do lote)", async () => {
      const items = Array.from({ length: 1000 }, (_, i) => pos(`p${i}`, { valueBrl: "1.00" }));
      const res = await post("/api/clients/c1/positions", A.keys.ingest, { items });
      expect(res.status).toBe(201);
      expect((res.body as { upserted: number }).upserted).toBe(1000);
      expect(await countRows("position", A.tenantId)).toBe(1000);
    });

    it("corpo acima do limite do JSON → 413 em application/problem+json, nada cobrado", async () => {
      const res = await post("/api/clients/c1/positions", A.keys.ingest, {
        items: [pos("p1", { name: "x".repeat(6 * 1024 * 1024) })],
      });
      expectProblem(res, 413);
      expect(await usageRows(A.tenantId)).toEqual([]);
    });

    it("valores nos limites das colunas passam e voltam exatos", async () => {
      await post("/api/clients/c1/positions", A.keys.ingest, {
        items: [
          pos("max", { valueBrl: "9999999999999999.99", quantity: "9999999999999999.12345678" }),
          pos("neg", { valueBrl: "-0.01", quantity: "0.00000001" }),
        ],
      }).expect(201);
      const list = (await get("/api/clients/c1/positions", A.keys.chat).expect(200)).body
        .positions as {
        externalId: string;
        valueBrl: string;
        quantity: string;
      }[];
      const byId = Object.fromEntries(list.map((p) => [p.externalId, p]));
      expect(byId["max"]).toMatchObject({
        valueBrl: "9999999999999999.99",
        quantity: "9999999999999999.12345678",
      });
      expect(byId["neg"]).toMatchObject({ valueBrl: "-0.01", quantity: "0.00000001" });
    });

    it("valor que o banco recusa (data ano 0000) → 422 e o lote inteiro é desfeito", async () => {
      const res = await post("/api/clients/c1/positions", A.keys.ingest, {
        items: [pos("ok"), pos("bad", { asOf: "0000-01-01" })],
      });
      expectProblem(res, 422);
      expect(await countRows("position", A.tenantId)).toBe(0);
      expect(await usageRows(A.tenantId)).toEqual([]);
      expect(await jobEvents()).toEqual([]);
    });

    it("caractere NUL numa string → 422, nunca 500", async () => {
      const res = await post("/api/clients/c1/positions", A.keys.ingest, {
        items: [pos("p1", { name: "a\u0000b" })],
      });
      expectProblem(res, 422);
      expect(await usageRows(A.tenantId)).toEqual([]);
    });

    it("chave sem data:write → 403; sem chave → 401; nada é gravado", async () => {
      const items = [pos("p1")];
      expect(
        expectProblem(await post("/api/clients/c1/positions", A.keys.chat, { items }), 403).type,
      ).toMatch(/forbidden_scope$/);
      expect(
        expectProblem(await post("/api/clients/c1/positions", A.keys.approver, { items }), 403)
          .status,
      ).toBe(403);
      expectProblem(await post("/api/clients/c1/positions", undefined, { items }), 401);
      expect(await clientRowId(A.tenantId, "c1")).toBeUndefined();
      expect(await usageRows(A.tenantId)).toEqual([]);
    });

    it("clientId malformado → 422 e nada é cobrado", async () => {
      const res = await post(`/api/clients/${"x".repeat(129)}/positions`, A.keys.ingest, {
        items: [pos("p1")],
      });
      expectProblem(res, 422);
      expect(await usageRows(A.tenantId)).toEqual([]);
    });

    it("cada POST cria exatamente um usage_record data_ingestion de R$ 0,05, por lote", async () => {
      const r1 = await post("/api/clients/c1/positions", A.keys.ingest, {
        items: [pos("p1"), pos("p2"), pos("p3")],
      });
      expect(r1.body).toEqual({
        upserted: 3,
        usage: { workType: "data_ingestion", priceBrl: "0.05" },
      });
      let rows = await usageRows(A.tenantId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ work_type: "data_ingestion", price_brl: "0.05" });
      expect(rows[0]?.client_id).toBe(await clientRowId(A.tenantId, "c1"));

      await post("/api/clients/c1/positions", A.keys.ingest, { items: [pos("p1")] }).expect(201);
      rows = await usageRows(A.tenantId);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.work_type === "data_ingestion" && r.price_brl === "0.05")).toBe(
        true,
      );
    });

    it("cada POST deixa um evento data.ingested em jobs (source api, ids do tenant e do cliente)", async () => {
      await post("/api/clients/c1/positions", A.keys.ingest, { items: [pos("p1")] }).expect(201);
      await post("/api/clients/c1/positions", A.keys.ingest, { items: [pos("p1")] }).expect(201);
      const events = await jobEvents();
      expect(events).toHaveLength(2);
      const clientId = await clientRowId(A.tenantId, "c1");
      for (const e of events) {
        expect(e).toMatchObject({
          type: "data.ingested",
          source: "api",
          tenantId: A.tenantId,
          clientId,
        });
      }
      expect(new Set(events.map((e) => e.eventId)).size).toBe(2);
    });

    it("falha ao cobrar desfaz o upsert: lote cobrado ⇔ lote gravado", async () => {
      const billing = t.app.get(BillingService);
      vi.spyOn(billing, "record").mockRejectedValueOnce(new Error("cobrança indisponível"));
      const res = await post("/api/clients/c1/positions", A.keys.ingest, { items: [pos("p1")] });
      expectProblem(res, 500);
      expect(await countRows("position", A.tenantId)).toBe(0);
      expect(await usageRows(A.tenantId)).toEqual([]);
      expect(await jobEvents()).toEqual([]);
    });

    it("o upsert e a cobrança usam a mesma transação (BillingService.record recebe tx)", async () => {
      const billing = t.app.get(BillingService);
      const spy = vi.spyOn(billing, "record");
      await post("/api/clients/c1/positions", A.keys.ingest, { items: [pos("p1")] }).expect(201);
      expect(spy).toHaveBeenCalledTimes(1);
      const input = spy.mock.calls[0]?.[0];
      expect(input?.tx).toBeDefined();
      expect(input?.workType).toBe("data_ingestion");
    });

    it("falha ao publicar data.ingested: 201, dados e cobrança confirmados, erro logado com err no topo", async () => {
      const boom = new Error("redis fora do ar");
      vi.spyOn(t.app.get(StreamsService), "publish").mockRejectedValueOnce(boom);
      const logger = t.app.get<IngestionLogger>(INGESTION_LOGGER);
      const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);

      const res = await post("/api/clients/c1/positions", A.keys.ingest, { items: [pos("p1")] });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        upserted: 1,
        usage: { workType: "data_ingestion", priceBrl: "0.05" },
      });
      expect(await countRows("position", A.tenantId)).toBe(1);
      expect(await usageRows(A.tenantId)).toHaveLength(1);

      expect(errorLog).toHaveBeenCalledTimes(1);
      const fields = errorLog.mock.calls[0]?.[0];
      expect(fields?.msg).toEqual(expect.any(String));
      expect(fields?.err).toBe(boom);
    });
  });

  describe("GET positions", () => {
    it("devolve o contrato NormalizedPosition, sem ids internos nem colunas internas", async () => {
      await post("/api/clients/c1/positions", A.keys.ingest, {
        items: [
          pos("p1", { quantity: "10.5", valueBrl: "100.5" }),
          pos("cash", {
            kind: "cash",
            assetClass: "caixa",
            assetCode: undefined,
            quantity: undefined,
            name: "Conta",
          }),
        ],
      }).expect(201);
      const res = await get("/api/clients/c1/positions", A.keys.chat).expect(200);
      const page = res.body as { positions: Record<string, unknown>[]; nextCursor: string | null };
      expect(page.nextCursor).toBeNull();
      const body = page.positions;
      expect(body).toHaveLength(2);
      for (const p of body) {
        NormalizedPositionSchema.strict().parse(p);
      }
      const p1 = body.find((p) => p["externalId"] === "p1");
      expect(p1).toEqual({
        externalId: "p1",
        institution: "XP",
        kind: "investment",
        assetClass: "acao",
        assetCode: "PETR4",
        name: "Ativo p1",
        quantity: "10.5",
        valueBrl: "100.50",
        asOf: "2026-11-10",
      });
      const clientId = (await clientRowId(A.tenantId, "c1")) as string;
      expect(res.text).not.toContain(A.tenantId);
      expect(res.text).not.toContain(clientId);
      expect(res.text).not.toMatch(/tenantId|clientId|createdAt|updatedAt|"source"|"id"/);
    });

    it("cliente inexistente → 404 e o GET não cria o cliente", async () => {
      expectProblem(await get("/api/clients/nao-existe/positions", A.keys.chat), 404);
      expect(await clientRowId(A.tenantId, "nao-existe")).toBeUndefined();
    });

    it("cliente existente sem posições → 200 []", async () => {
      await post("/api/clients/c1/transactions", A.keys.ingest, { items: [txn("t1")] }).expect(201);
      const res = await get("/api/clients/c1/positions", A.keys.chat).expect(200);
      expect(res.body).toEqual({ positions: [], nextCursor: null });
    });

    describe("paginação (limit e after)", () => {
      type Page = { positions: { externalId: string }[]; nextCursor: string | null };
      const ids = (n: number) =>
        Array.from({ length: n }, (_, i) => `p${String(i).padStart(4, "0")}`);
      const seed = async (n: number) => {
        // Em ordem embaralhada: a ordem da resposta é por externalId, não a de inserção.
        const items = ids(n)
          .reverse()
          .map((id) => pos(id, { valueBrl: "1.00" }));
        await post("/api/clients/c1/positions", A.keys.ingest, { items }).expect(201);
      };
      const page = async (query: string, key = A.keys.chat) =>
        (await get(`/api/clients/c1/positions${query}`, key).expect(200)).body as Page;

      it("padrão de 100 itens por página, com nextCursor quando há mais", async () => {
        await seed(150);
        const first = await page("");
        expect(first.positions).toHaveLength(100);
        expect(first.positions.map((p) => p.externalId)).toEqual(ids(150).slice(0, 100));
        expect(first.nextCursor).toEqual(expect.any(String));
        const second = await page(`?after=${encodeURIComponent(first.nextCursor as string)}`);
        expect(second.positions.map((p) => p.externalId)).toEqual(ids(150).slice(100));
        expect(second.nextCursor).toBeNull();
      });

      it("percorrer todas as páginas pelo nextCursor devolve cada linha uma vez, em ordem", async () => {
        await seed(130);
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const q: string = `?limit=40${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`;
          const p: Page = await page(q);
          seen.push(...p.positions.map((x) => x.externalId));
          cursor = p.nextCursor;
          pages++;
        } while (cursor);
        expect(pages).toBe(4);
        expect(seen).toEqual(ids(130));
      });

      it("limit igual ao total: uma página só, nextCursor nulo", async () => {
        await seed(5);
        const p = await page("?limit=5");
        expect(p.positions).toHaveLength(5);
        expect(p.nextCursor).toBeNull();
      });

      it("linhas de fontes diferentes com o mesmo externalId não se perdem nem se repetem entre páginas", async () => {
        await seed(3);
        const clientId = await clientRowId(A.tenantId, "c1");
        await migratorSql(
          `INSERT INTO position (tenant_id, client_id, source, external_id, institution, kind,
             asset_class, name, value_brl, as_of)
           SELECT $1, $2, 'synthetic', external_id, 'XP', 'investment', 'acao', 'sintético', 1,
                  current_date
           FROM position WHERE source = 'api'`,
          [A.tenantId, clientId],
          { tenantId: A.tenantId },
        );
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const q: string = `?limit=1${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`;
          const p: Page = await page(q);
          seen.push(...p.positions.map((x) => x.externalId));
          cursor = p.nextCursor;
        } while (cursor);
        expect(seen).toEqual(["p0000", "p0000", "p0001", "p0001", "p0002", "p0002"]);
      });

      it("parâmetros inválidos → 422", async () => {
        await seed(2);
        for (const q of [
          "?limit=0",
          "?limit=1001",
          "?limit=-1",
          "?limit=abc",
          "?limit=1.5",
          "?limit=",
          "?limit=1&limit=2",
          "?after=",
          "?after=lixo",
          `?after=${"x".repeat(2000)}`,
          "?after=a&after=b",
        ]) {
          expectProblem(await get(`/api/clients/c1/positions${q}`, A.keys.chat), 422);
        }
        expect((await page("?limit=1000")).positions).toHaveLength(2);
      });

      it("cliente inexistente ou de outro tenant → 404, também com after", async () => {
        await seed(2);
        const cursor = (await page("?limit=1")).nextCursor as string;
        const q = `?limit=1&after=${encodeURIComponent(cursor)}`;
        expectProblem(await get(`/api/clients/nao-existe/positions${q}`, A.keys.chat), 404);
        // O cursor de A não abre o cliente de A para B.
        expectProblem(await get(`/api/clients/c1/positions${q}`, B.keys.chat), 404);
      });
    });

    it("chave sem o escopo chat → 403", async () => {
      expectProblem(await get("/api/clients/c1/positions", A.keys.ingest), 403);
      expectProblem(await get("/api/clients/c1/transactions", A.keys.ingest), 403);
    });
  });

  describe("isolamento entre tenants", () => {
    it("tenant B não vê nem sobrescreve os dados do cliente de A", async () => {
      await post("/api/clients/c1/positions", A.keys.ingest, {
        items: [pos("p1", { name: "de A", valueBrl: "1.00" })],
      }).expect(201);
      await post("/api/clients/c1/transactions", A.keys.ingest, { items: [txn("t1")] }).expect(201);

      // B consulta um cliente que só existe em A: 404 (igual a inexistente).
      expectProblem(await get("/api/clients/c1/positions", B.keys.chat), 404);
      expectProblem(await get("/api/clients/c1/transactions", B.keys.chat), 404);
      const aClientId = (await clientRowId(A.tenantId, "c1")) as string;
      // O uuid interno do cliente de A também não resolve para B.
      expectProblem(await get(`/api/clients/${aClientId}/positions`, B.keys.chat), 404);

      // Mesmo clientId e mesmo externalId em B: cria o cliente de B, sem tocar no de A.
      await post("/api/clients/c1/positions", B.keys.ingest, {
        items: [pos("p1", { name: "de B", valueBrl: "2.00" })],
      }).expect(201);
      const a = (await get("/api/clients/c1/positions", A.keys.chat).expect(200)).body
        .positions as {
        name: string;
        valueBrl: string;
      }[];
      const b = (await get("/api/clients/c1/positions", B.keys.chat).expect(200)).body
        .positions as {
        name: string;
        valueBrl: string;
      }[];
      expect(a).toEqual([expect.objectContaining({ name: "de A", valueBrl: "1.00" })]);
      expect(b).toEqual([expect.objectContaining({ name: "de B", valueBrl: "2.00" })]);
      expect(await countRows("position", A.tenantId)).toBe(1);
      expect(await countRows("position", B.tenantId)).toBe(1);
      expect((await usageRows(A.tenantId)).length).toBe(2);
      expect((await usageRows(B.tenantId)).length).toBe(1);
    });

    it("POST de B não cria nada no cliente de A: o evento e a cobrança são de B", async () => {
      await post("/api/clients/c1/positions", A.keys.ingest, { items: [pos("p1")] }).expect(201);
      await post("/api/clients/c1/positions", B.keys.ingest, { items: [pos("p1")] }).expect(201);
      const events = await jobEvents();
      expect(events.map((e) => e.tenantId).sort()).toEqual([A.tenantId, B.tenantId].sort());
      const bClient = await clientRowId(B.tenantId, "c1");
      const bEvent = events.find((e) => e.tenantId === B.tenantId);
      expect(bEvent?.clientId).toBe(bClient);
    });
  });

  describe("POST/GET transactions", () => {
    it("o mesmo lote duas vezes deixa as mesmas linhas; externalId repetido: o último vence", async () => {
      const items = [
        txn("t1", { description: "primeiro", amountBrl: "-1.00" }),
        txn("t2"),
        txn("t1", { description: "último", amountBrl: "-2.00", category: "mercado" }),
      ];
      const r1 = await post("/api/clients/c1/transactions", A.keys.ingest, { items });
      const r2 = await post("/api/clients/c1/transactions", A.keys.ingest, { items });
      expect(r1.status).toBe(201);
      expect(r1.body).toEqual({
        upserted: 2,
        usage: { workType: "data_ingestion", priceBrl: "0.05" },
      });
      expect(r2.status).toBe(201);
      expect(await countRows("transaction", A.tenantId)).toBe(2);

      const list = (await get("/api/clients/c1/transactions", A.keys.chat).expect(200)).body as {
        externalId: string;
        description: string;
        amountBrl: string;
        category?: string;
      }[];
      expect(list).toHaveLength(2);
      expect(list.find((x) => x.externalId === "t1")).toMatchObject({
        description: "último",
        amountBrl: "-2.00",
        category: "mercado",
      });
    });

    it("GET devolve o contrato NormalizedTransaction, sem ids nem colunas internas", async () => {
      await post("/api/clients/c1/transactions", A.keys.ingest, {
        items: [
          txn("t1", {
            kind: "buy",
            assetCode: "PETR4",
            quantity: "10",
            amountBrl: "-350.5",
            category: "invest",
          }),
          txn("t2"),
        ],
      }).expect(201);
      const res = await get("/api/clients/c1/transactions", A.keys.chat).expect(200);
      const body = res.body as Record<string, unknown>[];
      for (const x of body) NormalizedTransactionSchema.strict().parse(x);
      expect(body.find((x) => x["externalId"] === "t1")).toEqual({
        externalId: "t1",
        institution: "Itaú",
        account: "cc-1",
        date: "2026-10-15",
        description: "Lançamento t1",
        amountBrl: "-350.50",
        kind: "buy",
        category: "invest",
        assetCode: "PETR4",
        quantity: "10",
      });
      expect(res.text).not.toContain(A.tenantId);
      expect(res.text).not.toContain((await clientRowId(A.tenantId, "c1")) as string);
      expect(res.text).not.toMatch(/tenantId|clientId|createdAt|"source"|"id"/);
    });

    it("cobra e publica como as posições; item inválido cita o caminho; 1.001 itens → 422", async () => {
      await post("/api/clients/c1/transactions", A.keys.ingest, { items: [txn("t1")] }).expect(201);
      expect(await usageRows(A.tenantId)).toHaveLength(1);
      expect((await jobEvents()).map((e) => e.type)).toEqual(["data.ingested"]);

      const bad = await post("/api/clients/c1/transactions", A.keys.ingest, {
        items: [txn("t2", { amountBrl: "1.234" })],
      });
      expect(expectProblem(bad, 422).detail).toContain("items.0.amountBrl");
      const big = Array.from({ length: 1001 }, (_, i) => txn(`t${i}`));
      expectProblem(await post("/api/clients/c1/transactions", A.keys.ingest, { items: big }), 422);
      expectProblem(await post("/api/clients/c1/transactions", A.keys.ingest, { items: [] }), 422);
      expectProblem(
        await post("/api/clients/c1/transactions", A.keys.chat, { items: [txn("t9")] }),
        403,
      );
      expect(await usageRows(A.tenantId)).toHaveLength(1);
    });

    describe("filtros e limite", () => {
      beforeEach(async () => {
        await post("/api/clients/c1/transactions", A.keys.ingest, {
          items: [
            txn("a", { date: "2026-01-10" }),
            txn("b", { date: "2026-02-10" }),
            txn("c", { date: "2026-03-10" }),
            txn("d", { date: "2026-03-10" }),
            txn("e", { date: "2026-04-10" }),
          ],
        }).expect(201);
      });

      const ids = async (query: string) => {
        const res = await get(`/api/clients/c1/transactions${query}`, A.keys.chat).expect(200);
        return (res.body as { externalId: string }[]).map((x) => x.externalId);
      };

      it("mais recentes primeiro (desempate estável por externalId)", async () => {
        expect(await ids("")).toEqual(["e", "c", "d", "b", "a"]);
      });

      it("from e to são inclusivos", async () => {
        expect(await ids("?from=2026-02-10")).toEqual(["e", "c", "d", "b"]);
        expect(await ids("?to=2026-03-10")).toEqual(["c", "d", "b", "a"]);
        expect(await ids("?from=2026-02-10&to=2026-03-10")).toEqual(["c", "d", "b"]);
        expect(await ids("?from=2026-03-10&to=2026-03-10")).toEqual(["c", "d"]);
        expect(await ids("?from=2027-01-01")).toEqual([]);
      });

      it("limit corta a lista; 1000 é aceito", async () => {
        expect(await ids("?limit=2")).toEqual(["e", "c"]);
        expect(await ids("?limit=1000")).toHaveLength(5);
      });

      it("padrão de 100 itens", async () => {
        await post("/api/clients/c2/transactions", A.keys.ingest, {
          items: Array.from({ length: 120 }, (_, i) => txn(`t${i}`)),
        }).expect(201);
        const res = await get("/api/clients/c2/transactions", A.keys.chat).expect(200);
        expect(res.body as unknown[]).toHaveLength(100);
      });

      it("parâmetros inválidos → 422", async () => {
        for (const q of [
          "?limit=0",
          "?limit=1001",
          "?limit=-1",
          "?limit=abc",
          "?limit=1.5",
          "?limit=",
          "?limit=1&limit=2",
          "?from=2026-13-01",
          "?from=2026-02-30",
          "?from=10/02/2026",
          "?to=amanhã",
          "?from=2026-04-01&to=2026-03-01",
        ]) {
          expectProblem(await get(`/api/clients/c1/transactions${q}`, A.keys.chat), 422);
        }
      });
    });
  });

  it("lotes concorrentes do mesmo cliente com externalIds sobrepostos, em ordens opostas, não dão deadlock", async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `p${i}`);
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) => {
        const ordered = i % 2 === 0 ? ids : [...ids].reverse();
        return post("/api/clients/c1/positions", A.keys.ingest, {
          items: ordered.map((id) => pos(id, { name: `lote ${i}` })),
        });
      }),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(201));
    expect(await countRows("position", A.tenantId)).toBe(200);
    expect(await usageRows(A.tenantId)).toHaveLength(8);
  });

  it("requisições concorrentes de A e B para o mesmo clientId não misturam os dados", async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => {
        const tenant = i % 2 === 0 ? A : B;
        return post("/api/clients/c1/positions", tenant.keys.ingest, {
          items: [pos(`p${i}`, { name: tenant === A ? "A" : "B" })],
        }).expect(201);
      }),
    );
    const a = (await get("/api/clients/c1/positions", A.keys.chat).expect(200)).body.positions as {
      name: string;
    }[];
    const b = (await get("/api/clients/c1/positions", B.keys.chat).expect(200)).body.positions as {
      name: string;
    }[];
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(3);
    expect(a.every((p) => p.name === "A")).toBe(true);
    expect(b.every((p) => p.name === "B")).toBe(true);
  });
});
