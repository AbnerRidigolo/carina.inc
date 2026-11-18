import {
  ImportJobListSchema,
  ImportJobViewSchema,
  ProblemSchema,
  StreamEventSchema,
} from "@carina/shared";
import type { Redis } from "ioredis";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { REDIS } from "../../src/core/redis/redis.tokens.js";
import { StreamsService } from "../../src/core/redis/streams.service.js";
import { ImportsModule } from "../../src/modules/imports/imports.module.js";
import { IMPORTS_LOGGER, type ImportsLogger } from "../../src/modules/imports/imports.service.js";
import { createTestApp, type SeededTenant, type TestApp } from "../setup/app.js";
import { migratorSql } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

// DB lógico próprio (test/setup/redis-dbs.ts): este arquivo faz flushdb a cada teste.
const REDIS_DB = redisDbOf("imports/imports.e2e.spec.ts");

/** OFX distinto por `n` (o SHA-256 muda): um extrato mínimo de conta corrente. */
const ofx = (n = 0) =>
  Buffer.from(
    `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nCHARSET:1252\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>` +
      `<BANKACCTFROM><BANKID>001<ACCTID>${n}</BANKACCTFROM><BANKTRANLIST>` +
      `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261001<TRNAMT>-10.00<FITID>${n}<MEMO>x</STMTTRN>` +
      `</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
    "latin1",
  );

const csvBytes = Buffer.from("Data;Valor;Descrição\n01/10/2026;-10,00;Mercado\n", "utf8");

const PATH = "/api/clients/c1/imports";

describe("Importação de arquivos E2E: /api/clients/:clientId/imports", () => {
  let t: TestApp;
  let server: Parameters<typeof request>[0];
  let redis: Redis;
  let A: SeededTenant;
  let B: SeededTenant;
  let logger: ImportsLogger;

  beforeAll(async () => {
    logger = { error: vi.fn() };
    t = await createTestApp({
      imports: [ImportsModule],
      redisDb: REDIS_DB,
      overrides: [{ token: IMPORTS_LOGGER, useValue: logger }],
    });
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

  const upload = (
    key: string | undefined,
    bytes: Buffer | undefined,
    fields: Record<string, string> = {},
    filename = "extrato.ofx",
    path = PATH,
  ) => {
    let req = request(server)
      .post(path)
      .set(key ? { "X-API-Key": key } : {});
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    if (bytes) req = req.attach("file", bytes, filename);
    return req;
  };
  const get = (path: string, key: string | undefined) =>
    request(server)
      .get(path)
      .set(key ? { "X-API-Key": key } : {});

  const expectProblem = (res: request.Response, status: number) => {
    expect(res.status).toBe(status);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    ProblemSchema.parse(res.body);
  };

  const rows = <T extends object>(sql: string, tenantId: string) =>
    migratorSql<T>(sql, [tenantId], { tenantId });
  const jobRows = (tenantId: string) =>
    rows<{ id: string; status: string; options: unknown; failure_code: string | null }>(
      `SELECT id, status, options, failure_code FROM import_job WHERE tenant_id = $1 ORDER BY created_at`,
      tenantId,
    );
  const fileRows = (tenantId: string) =>
    rows<{ import_job_id: string; len: number }>(
      `SELECT import_job_id, octet_length(bytes) AS len FROM import_file WHERE tenant_id = $1`,
      tenantId,
    );
  const usageCount = async (tenantId: string) =>
    Number(
      (
        await rows<{ n: string }>(
          `SELECT count(*)::text AS n FROM usage_record WHERE tenant_id = $1`,
          tenantId,
        )
      )[0]?.n,
    );
  const jobEvents = async () =>
    (await redis.xrange("jobs", "-", "+")).map(([, f]) =>
      StreamEventSchema.parse(JSON.parse(f[1] as string)),
    );

  describe("POST", () => {
    it("OFX válido: 202 queued, import_file gravado, auditoria e evento import.requested", async () => {
      const bytes = ofx();
      const res = await upload(A.keys.ingest, bytes, {}, "../../Meu Extrato.ofx");
      expect(res.status).toBe(202);
      const job = ImportJobViewSchema.parse(res.body);
      expect(job).toMatchObject({ format: "ofx", status: "queued", fileName: "Meu Extrato.ofx" });
      expect(job.stats.rowsRead).toBe(0);

      expect(await jobRows(A.tenantId)).toHaveLength(1);
      expect(await fileRows(A.tenantId)).toEqual([{ import_job_id: job.id, len: bytes.length }]);
      const audit = await rows<{ channel: string; query: string; agents: string[] }>(
        `SELECT channel, query, agents FROM audit_event WHERE tenant_id = $1`,
        A.tenantId,
      );
      expect(audit).toEqual([{ channel: "import", query: "import.created", agents: [] }]);
      expect(JSON.stringify(audit)).not.toContain("Extrato");
      const events = await jobEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "import.requested", importJobId: job.id });
      expect(await usageCount(A.tenantId)).toBe(0);
    });

    it("nome de arquivo em UTF-8 chega íntegro", async () => {
      const res = await upload(A.keys.ingest, ofx(), {}, "ação ç.ofx").expect(202);
      expect((res.body as { fileName: string }).fileName).toBe("ação ç.ofx");
    });

    it("o mesmo arquivo de novo: 200 com o mesmo id, sem novo job, evento nem cobrança", async () => {
      const first = await upload(A.keys.ingest, ofx(), {}).expect(202);
      const again = await upload(A.keys.ingest, ofx(), {}).expect(200);
      expect((again.body as { id: string }).id).toBe((first.body as { id: string }).id);
      expect(await jobRows(A.tenantId)).toHaveLength(1);
      expect(await jobEvents()).toHaveLength(1);
      expect(await usageCount(A.tenantId)).toBe(0);
    });

    it("job failed + reenvio: 202 com o mesmo id, queued, bytes regravados, novo evento", async () => {
      const first = await upload(A.keys.ingest, ofx(), {}).expect(202);
      const id = (first.body as { id: string }).id;
      await migratorSql(
        `UPDATE import_job SET status = 'failed', failure_code = 'expired',
           stats = '{"rowsRead":9,"positions":0,"transactions":0,"errorRows":1,"ignored":{}}',
           errors = '[{"row":1,"code":"x","message":"m"}]' WHERE id = $1`,
        [id],
        { tenantId: A.tenantId },
      );
      await migratorSql(`DELETE FROM import_file WHERE import_job_id = $1`, [id], {
        tenantId: A.tenantId,
      });

      const res = await upload(A.keys.ingest, ofx(), {}).expect(202);
      const job = ImportJobViewSchema.parse(res.body);
      expect(job).toMatchObject({ id, status: "queued", failureCode: null, errors: [] });
      expect(job.stats.rowsRead).toBe(0);
      expect(await jobRows(A.tenantId)).toHaveLength(1);
      expect((await fileRows(A.tenantId)).map((f) => f.import_job_id)).toEqual([id]);
      expect(await jobEvents()).toHaveLength(2);
    });

    it("acima de 10 MB: 413 problem+json, nada gravado", async () => {
      const big = Buffer.concat([ofx(), Buffer.alloc(10 * 1024 * 1024 + 1, 0x20)]);
      const res = await upload(A.keys.ingest, big, {});
      expectProblem(res, 413);
      expect(await jobRows(A.tenantId)).toHaveLength(0);
    });

    it("exatamente 10 MB passa", async () => {
      const base = ofx();
      const exact = Buffer.concat([base, Buffer.alloc(10 * 1024 * 1024 - base.length, 0x20)]);
      await upload(A.keys.ingest, exact, {}).expect(202);
    });

    it("arquivo ausente ou vazio: 422", async () => {
      expectProblem(await upload(A.keys.ingest, undefined, { format: "ofx" }), 422);
      expectProblem(await upload(A.keys.ingest, Buffer.alloc(0), {}), 422);
      expect(await jobRows(A.tenantId)).toHaveLength(0);
    });

    it("PNG: 422", async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
      expectProblem(await upload(A.keys.ingest, png, {}, "a.png"), 422);
      expect(await jobRows(A.tenantId)).toHaveLength(0);
    });

    it("format=csv com um OFX: 422", async () => {
      const res = await upload(A.keys.ingest, ofx(), { format: "csv", account: "cc" });
      expectProblem(res, 422);
    });

    it("campo desconhecido: 422", async () => {
      expectProblem(await upload(A.keys.ingest, ofx(), { foo: "bar" }), 422);
    });

    it("CSV sem account: 422; sem mapeamento: 422; mapeamento inválido: 422", async () => {
      expectProblem(
        await upload(
          A.keys.ingest,
          csvBytes,
          { csvPreset: "generico_br", institution: "Banco" },
          "a.csv",
        ),
        422,
      );
      expectProblem(
        await upload(A.keys.ingest, csvBytes, { institution: "Banco", account: "cc" }, "a.csv"),
        422,
      );
      expectProblem(
        await upload(
          A.keys.ingest,
          csvBytes,
          { csvMapping: "{nope", institution: "B", account: "cc" },
          "a.csv",
        ),
        422,
      );
      expect(await jobRows(A.tenantId)).toHaveLength(0);
    });

    it("CSV com preset: o preset preenche a instituição quando o campo vem vazio", async () => {
      const res = await upload(
        A.keys.ingest,
        csvBytes,
        { csvPreset: "nubank_conta", institution: "", account: "Conta" },
        "a.csv",
      ).expect(202);
      expect(ImportJobViewSchema.parse(res.body).format).toBe("csv");
      const [job] = await jobRows(A.tenantId);
      expect(job?.options).toMatchObject({
        format: "csv",
        institution: "Nubank",
        account: "Conta",
        csvPreset: "nubank_conta",
      });
    });

    it("CSV com mapeamento explícito é guardado em options", async () => {
      const csvMapping = JSON.stringify({
        date: "Data",
        amount: "Valor",
        description: "Descrição",
        dateFormat: "dd/MM/yyyy",
        decimal: "comma",
      });
      await upload(
        A.keys.ingest,
        csvBytes,
        { csvMapping, institution: "Banco", account: "cc", format: "csv" },
        "a.csv",
      ).expect(202);
      const [job] = await jobRows(A.tenantId);
      expect(job?.options).toMatchObject({ csvMapping: { date: "Data" }, institution: "Banco" });
    });

    it("sexto job ativo: 429 com Retry-After; o mesmo arquivo já enfileirado ainda responde 200", async () => {
      for (let i = 0; i < 5; i++) await upload(A.keys.ingest, ofx(i), {}).expect(202);
      const res = await upload(A.keys.ingest, ofx(99), {});
      expectProblem(res, 429);
      expect(res.headers["retry-after"]).toBe("30");
      expect(await jobRows(A.tenantId)).toHaveLength(5);
      await upload(A.keys.ingest, ofx(0), {}).expect(200);
    });

    it("uploads concorrentes do mesmo arquivo criam um job só", async () => {
      const rs = await Promise.all(
        Array.from({ length: 4 }, () => upload(A.keys.ingest, ofx(7), {})),
      );
      expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 200, 202]);
      expect(await jobRows(A.tenantId)).toHaveLength(1);
    });

    it("falha ao publicar: continua 202, o job fica queued e o erro é logado sem nome de arquivo", async () => {
      vi.spyOn(t.app.get(StreamsService), "publish").mockRejectedValueOnce(new Error("redis fora"));
      const res = await upload(A.keys.ingest, ofx(), {}, "segredo.ofx").expect(202);
      expect((res.body as { status: string }).status).toBe("queued");
      expect(logger.error).toHaveBeenCalledOnce();
      expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("segredo");
      expect(await jobEvents()).toHaveLength(0);
    });

    it("chave sem data:write: 403; sem chave: 401", async () => {
      expectProblem(await upload(A.keys.chat, ofx(), {}), 403);
      expectProblem(await upload(undefined, ofx(), {}), 401);
      expect(await jobRows(A.tenantId)).toHaveLength(0);
    });

    it("o mesmo arquivo em tenants diferentes gera jobs independentes", async () => {
      const a = await upload(A.keys.ingest, ofx(), {}).expect(202);
      const b = await upload(B.keys.ingest, ofx(), {}).expect(202);
      expect((a.body as { id: string }).id).not.toBe((b.body as { id: string }).id);
    });
  });

  describe("GET", () => {
    it("com chave chat: 200 e ImportJobViewSchema válido", async () => {
      const created = await upload(A.keys.ingest, ofx(), {}).expect(202);
      const id = (created.body as { id: string }).id;
      const res = await get(`${PATH}/${id}`, A.keys.chat).expect(200);
      expect(ImportJobViewSchema.parse(res.body).id).toBe(id);
    });

    it("job de outro tenant, id inexistente ou malformado: 404; sem escopo: 403", async () => {
      const created = await upload(A.keys.ingest, ofx(), {}).expect(202);
      const id = (created.body as { id: string }).id;
      expectProblem(await get(`${PATH}/${id}`, B.keys.chat), 404);
      expectProblem(await get(`${PATH}/00000000-0000-4000-8000-000000000000`, A.keys.chat), 404);
      expectProblem(await get(`${PATH}/nao-e-uuid`, A.keys.chat), 404);
      expectProblem(await get(`/api/clients/outro/imports/${id}`, A.keys.chat), 404);
      expectProblem(await get(`${PATH}/${id}`, A.keys.ingest), 403);
    });

    it("lista paginada, mais recentes primeiro, sem repetir nem pular", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await upload(A.keys.ingest, ofx(i), {}).expect(202);
        ids.push((r.body as { id: string }).id);
      }
      const seen: string[] = [];
      let after: string | undefined;
      let pages = 0;
      do {
        const q = `?limit=2${after ? `&after=${after}` : ""}`;
        const res = await get(`${PATH}${q}`, A.keys.chat).expect(200);
        const list = ImportJobListSchema.parse(res.body);
        seen.push(...list.items.map((j) => j.id));
        after = list.nextCursor ?? undefined;
        pages++;
      } while (after);
      expect(pages).toBe(3);
      expect(seen).toEqual([...ids].reverse());
    });

    it("lista: limit e cursor inválidos 422; cliente inexistente 404; outro tenant vazio", async () => {
      await upload(A.keys.ingest, ofx(), {}).expect(202);
      expectProblem(await get(`${PATH}?limit=0`, A.keys.chat), 422);
      expectProblem(await get(`${PATH}?limit=101`, A.keys.chat), 422);
      expectProblem(await get(`${PATH}?after=%25%25`, A.keys.chat), 422);
      expectProblem(await get("/api/clients/nope/imports", A.keys.chat), 404);
      await upload(B.keys.ingest, ofx(5), {}).expect(202);
      const res = await get(PATH, B.keys.chat).expect(200);
      expect(ImportJobListSchema.parse(res.body).items).toHaveLength(1);
    });
  });
});
