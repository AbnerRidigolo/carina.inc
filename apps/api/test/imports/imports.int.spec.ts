/**
 * Worker de importação e limpeza (spec §5.1, §5.5, §5.6): do `ImportsService.create` (o mesmo
 * caminho da rota) até o job fechado, com o parse numa worker thread, a gravação pelo
 * IngestionService em lotes de 1000, os eventos em `inbox.events` e a limpeza periódica.
 *
 * O worker não consome o stream aqui (WORKERS_ENABLED=false no createTestApp): cada teste lê o
 * `import.requested` publicado em `jobs` e chama `ImportWorker.handle` com ele. Redis: DB lógico
 * próprio (test/setup/redis-dbs.ts), esvaziado a cada teste. A limpeza roda só nos tenants do
 * teste (`onlyTenants`), porque os arquivos int compartilham o banco.
 */
import { readFileSync } from "node:fs";
import { StreamEventSchema, type ImportUploadFields, type StreamEvent } from "@carina/shared";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import { TenantPrismaService } from "../../src/core/database/tenant-prisma.service.js";
import { REDIS } from "../../src/core/redis/redis.tokens.js";
import {
  INGESTION_LOGGER,
  IngestionService,
} from "../../src/modules/data-ingestion/ingestion.service.js";
import { ImportCleanupJob } from "../../src/modules/imports/import-cleanup.job.js";
import { IMPORT_LOGGER, ImportWorker } from "../../src/modules/imports/import.worker.js";
import { ImportsCoreModule } from "../../src/modules/imports/imports-core.module.js";
import { ImportsRepository } from "../../src/modules/imports/imports.repository.js";
import { IMPORTS_LOGGER, ImportsService } from "../../src/modules/imports/imports.service.js";
import { runParser } from "../../src/modules/imports/parse-dispatch.js";
import { createTestApp, type TestApp } from "../setup/app.js";
import { migratorSql, must } from "../setup/db.js";
import { redisDbOf } from "../setup/redis-dbs.js";

const REDIS_DB = redisDbOf("imports/imports.int.spec.ts");

const fixture = (dir: string, name: string): Buffer =>
  readFileSync(new URL(`../fixtures/imports/${dir}/${name}`, import.meta.url));

/** Descrições das transações das fixtures usadas aqui: nunca podem sair em log ou evento. */
const SECRETS = ["Padaria São João", "Salário outubro", "Conta de luz", "bonificacao"];

const GENERICO = { csvPreset: "generico_br", institution: "Banco Exemplo", account: "cc" };

/** CSV do preset generico_br com `n` linhas distintas. */
function csv(n: number, tag = "Compra"): Buffer {
  const lines = ["Data;Valor;Descrição;Categoria"];
  for (let i = 1; i <= n; i++)
    lines.push(`01/10/2025;-${i.toString()},00;${tag} ${i.toString()};Outros`);
  return Buffer.from(lines.join("\n") + "\n", "utf8");
}

describe("Importação de arquivos: worker e limpeza (integração)", () => {
  let t: TestApp;
  let redis: Redis;
  let worker: ImportWorker;
  let cleanup: ImportCleanupJob;
  let imports: ImportsService;
  let ingestion: IngestionService;
  let repo: ImportsRepository;
  let db: TenantPrismaService;
  const logged: unknown[] = [];
  const fakeLogger = () => ({
    info: (f: unknown) => logged.push(f),
    warn: (f: unknown) => logged.push(f),
    error: (f: unknown) => logged.push(f),
  });
  let tenantId: string;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [ImportsCoreModule],
      redisDb: REDIS_DB,
      overrides: [
        { token: IMPORT_LOGGER, useValue: fakeLogger() },
        { token: IMPORTS_LOGGER, useValue: fakeLogger() },
        { token: INGESTION_LOGGER, useValue: fakeLogger() },
      ],
    });
    redis = t.app.get<Redis>(REDIS);
    worker = t.app.get(ImportWorker);
    cleanup = t.app.get(ImportCleanupJob);
    imports = t.app.get(ImportsService);
    ingestion = t.app.get(IngestionService);
    repo = t.app.get(ImportsRepository);
    db = t.app.get(TenantPrismaService);
  });

  afterAll(async () => {
    await redis.flushdb();
    await t.close();
  });

  beforeEach(async () => {
    await redis.flushdb();
    logged.length = 0;
    tenantId = (await t.seedTenant({ name: "Importa" })).tenantId;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── helpers ──────────────────────────────────────────────────────────────

  const upload = (bytes: Buffer, fields: ImportUploadFields = {}, tenant = tenantId) =>
    TenantContext.run({ tenantId: tenant }, () =>
      imports.create("c1", { bytes, originalName: "arquivo" }, fields),
    );

  const streamEvents = async (stream: "jobs" | "inbox.events"): Promise<StreamEvent[]> =>
    (await redis.xrange(stream, "-", "+")).map(([, f]) =>
      StreamEventSchema.parse(JSON.parse(f[1] as string)),
    );

  /** O último `import.requested` do job em `jobs`. */
  const requested = async (jobId: string): Promise<StreamEvent> =>
    must(
      (await streamEvents("jobs"))
        .filter((e) => e.type === "import.requested" && e.importJobId === jobId)
        .at(-1),
      "import.requested",
    );

  const run = async (jobId: string) => worker.handle(await requested(jobId));

  const sql = <R extends object>(text: string, params: unknown[] = []) =>
    migratorSql<R & Record<string, unknown>>(text, [tenantId, ...params], { tenantId });

  const jobRow = async (jobId: string) =>
    must(
      (
        await sql<{
          status: string;
          failure_code: string | null;
          stats: { rowsRead: number; positions: number; transactions: number; errorRows: number };
          errors: { code: string; row: number; message: string }[];
        }>(
          `SELECT status, failure_code, stats, errors FROM import_job WHERE tenant_id = $1 AND id = $2`,
          [jobId],
        )
      )[0],
      "import_job",
    );
  const count = async (table: string, where = "") =>
    Number(
      must(
        (
          await sql<{ n: string }>(
            `SELECT count(*)::text AS n FROM ${table} WHERE tenant_id = $1 ${where}`,
          )
        )[0],
      ).n,
    );
  const clientId = async () =>
    must((await sql<{ id: string }>(`SELECT id FROM client WHERE tenant_id = $1`))[0], "client").id;
  const inboxOf = async (jobId: string) =>
    (await streamEvents("inbox.events")).filter(
      (e) => "importJobId" in e && e.importJobId === jobId,
    );

  // ─── testes ───────────────────────────────────────────────────────────────

  it("OFX de ponta a ponta: done, transações source import, import_file vazio, 1 cobrança, data.ingested", async () => {
    const { job } = await upload(fixture("ofx", "conta-sgml-1252.ofx"));
    await run(job.id);

    const row = await jobRow(job.id);
    expect(row).toMatchObject({ status: "done", failure_code: null, errors: [] });
    expect(row.stats).toMatchObject({ rowsRead: 3, transactions: 3, errorRows: 0 });
    expect(await count("transaction", "AND source = 'import'")).toBe(3);
    expect(await count("transaction")).toBe(3);
    expect(await count("import_file")).toBe(0);
    expect(await count("usage_record", "AND work_type = 'data_ingestion'")).toBe(1);
    const jobs = await streamEvents("jobs");
    expect(jobs.filter((e) => e.type === "data.ingested")).toEqual([
      expect.objectContaining({ source: "import", clientId: await clientId() }),
    ]);
    const audit = await sql<{ query: string }>(
      `SELECT query FROM audit_event WHERE tenant_id = $1 AND channel = 'import' ORDER BY created_at`,
    );
    expect(audit.map((a) => a.query)).toEqual(["import.created", "import.finished:done"]);
    expect(
      (await inboxOf(job.id)).map((e) =>
        e.type === "import.progress"
          ? [e.type, e.stage, e.processed, e.total]
          : e.type === "import.finished"
            ? [e.type, e.status]
            : [e.type],
      ),
    ).toEqual([
      ["import.progress", "parsing", 0, 0],
      ["import.progress", "writing", 3, 3],
      ["import.finished", "done"],
    ]);
    for (const e of await inboxOf(job.id)) expect(e).toMatchObject({ tenantId });
  });

  it("OFX importado sai com categorias inferidas onde a regra casa", async () => {
    const { job } = await upload(fixture("ofx", "conta-sgml-1252.ofx"));
    await run(job.id);
    const rows = await sql<{ description: string; category: string | null }>(
      `SELECT description, category FROM "transaction" WHERE tenant_id = $1 ORDER BY description`,
    );
    // "Conta de luz" casa `luz` (moradia); padaria e salário não têm regra e ficam sem categoria.
    expect(rows.map((r) => [r.description, r.category])).toEqual([
      ["Conta de luz", "moradia"],
      ["Padaria São João", null],
      ["Salário outubro", null],
    ]);
  });

  it("CSV de 2 500 transações → 3 lotes, 3 cobranças, progresso 1000/2000/2500", async () => {
    const { job } = await upload(csv(2500), GENERICO);
    await run(job.id);

    expect(await jobRow(job.id)).toMatchObject({ status: "done" });
    expect(await count("transaction", "AND source = 'import'")).toBe(2500);
    expect(await count("usage_record", "AND work_type = 'data_ingestion'")).toBe(3);
    expect((await streamEvents("jobs")).filter((e) => e.type === "data.ingested")).toHaveLength(3);
    const writing = (await inboxOf(job.id)).flatMap((e) =>
      e.type === "import.progress" && e.stage === "writing" ? [[e.processed, e.total]] : [],
    );
    expect(writing).toEqual([
      [1000, 2500],
      [2000, 2500],
      [2500, 2500],
    ]);
  });

  it("reentrega do mesmo import.requested não processa de novo (claim)", async () => {
    const { job } = await upload(fixture("ofx", "conta-sgml-1252.ofx"));
    const event = await requested(job.id);
    await worker.handle(event);
    const before = (await streamEvents("inbox.events")).length;
    await worker.handle(event);
    await Promise.all([worker.handle(event), worker.handle(event)]);
    expect(await count("usage_record")).toBe(1);
    expect((await streamEvents("inbox.events")).length).toBe(before);
    expect((await jobRow(job.id)).status).toBe("done");
  });

  it("dois handles concorrentes do mesmo evento: só um processa", async () => {
    const { job } = await upload(fixture("ofx", "conta-sgml-1252.ofx"));
    const event = await requested(job.id);
    await Promise.all([worker.handle(event), worker.handle(event)]);
    expect(await count("usage_record")).toBe(1);
    expect((await inboxOf(job.id)).filter((e) => e.type === "import.finished")).toHaveLength(1);
  });

  it("B3: a posição importada das instituições do arquivo é substituída; api intocada", async () => {
    const { job } = await upload(fixture("xlsx", "b3-tres-abas.xlsx"), { asOf: "2025-10-31" });
    const client = await clientId();
    const insertPosition = (
      source: string,
      externalId: string,
      institution: string,
      asOf: string,
    ) =>
      migratorSql(
        `INSERT INTO position (tenant_id, client_id, source, external_id, institution, kind,
           asset_class, name, value_brl, as_of)
         VALUES ($1, $2, $3, $4, $5, 'investment', 'acao', 'Ativo vendido', 100, $6)`,
        [tenantId, client, source, externalId, institution, asOf],
        { tenantId, clientId: client },
      );
    await insertPosition("import", "b3:pos:vendido", "XP INVESTIMENTOS CCTVM S/A", "2025-10-01");
    await insertPosition("import", "b3:pos:outra", "Outra Corretora", "2025-10-01");
    await insertPosition("api", "b3:pos:vendido", "XP INVESTIMENTOS CCTVM S/A", "2025-10-01");

    await run(job.id);

    const row = await jobRow(job.id);
    expect(row.status).toBe("done");
    expect(row.stats).toMatchObject({ positions: 2, transactions: 6 });
    const positions = await sql<{ source: string; external_id: string }>(
      `SELECT source, external_id FROM position WHERE tenant_id = $1`,
    );
    const imported = positions.filter((p) => p.source === "import").map((p) => p.external_id);
    expect(imported).toHaveLength(3);
    expect(imported).not.toContain("b3:pos:vendido");
    expect(imported).toContain("b3:pos:outra");
    expect(positions.filter((p) => p.source === "api")).toHaveLength(1);
    expect(await count("transaction", "AND source = 'import'")).toBe(6);
    // posições (1 lote) + transações (1 lote)
    expect(await count("usage_record")).toBe(2);
  });

  it("B3: linha recusada (fórmula sem valor) não apaga a posição anterior do ativo; a instituição só recebe as válidas", async () => {
    const { job } = await upload(fixture("xlsx", "b3-posicao-linha-com-erro.xlsx"), {
      asOf: "2025-10-31",
    });
    const client = await clientId();
    const insertPosition = (externalId: string, institution: string) =>
      migratorSql(
        `INSERT INTO position (tenant_id, client_id, source, external_id, institution, kind,
           asset_class, name, value_brl, as_of)
         VALUES ($1, $2, 'import', $3, $4, 'investment', 'acao', 'Ativo', 100, '2025-10-01')`,
        [tenantId, client, externalId, institution],
        { tenantId, clientId: client },
      );
    // PETR4 da importação anterior (a linha dele agora tem fórmula sem valor).
    await insertPosition("b3:pos:petr4-anterior", "XP INVESTIMENTOS CCTVM S/A");
    // Instituição sem linha recusada: continua sendo substituída.
    await insertPosition("b3:pos:vendido", "Banco do Brasil");

    await run(job.id);

    const row = await jobRow(job.id);
    expect(row.status).toBe("done");
    expect(row.stats).toMatchObject({ positions: 2, errorRows: 1 });
    expect(row.errors.map((e) => e.code)).toEqual(["formula_without_value"]);
    const imported = (
      await sql<{ external_id: string }>(
        `SELECT external_id FROM position WHERE tenant_id = $1 AND source = 'import'`,
      )
    ).map((p) => p.external_id);
    expect(imported).toHaveLength(3);
    expect(imported).toContain("b3:pos:petr4-anterior");
    expect(imported).not.toContain("b3:pos:vendido");
  });

  it("B3 com fotografia mais antiga que a gravada: stale_snapshot em todas, nada substituído → no_valid_rows", async () => {
    const { job } = await upload(fixture("xlsx", "b3-posicao.xlsx"), { asOf: "2025-10-01" });
    const client = await clientId();
    await migratorSql(
      `INSERT INTO position (tenant_id, client_id, source, external_id, institution, kind,
         asset_class, name, value_brl, as_of)
       VALUES ($1, $2, 'import', 'b3:pos:novo', 'Banco Beta', 'investment', 'acao', 'x', 1, '2026-01-01')`,
      [tenantId, client],
      { tenantId, clientId: client },
    );
    await run(job.id);
    const row = await jobRow(job.id);
    expect(row).toMatchObject({ status: "failed", failure_code: "no_valid_rows" });
    expect(row.stats).toMatchObject({ positions: 0, errorRows: 6 });
    expect(row.errors.map((e) => e.code)).toEqual(Array(6).fill("stale_snapshot"));
    expect(await count("position")).toBe(1);
    expect(await count("usage_record")).toBe(0);
    expect(await count("import_file")).toBe(0);
  });

  it("arquivo ilegível → failed/unreadable, sem bytes e sem cobrança", async () => {
    const { job } = await upload(Buffer.from("OFXHEADER:100\nDATA:OFXSGML\n\nnada aqui\n"));
    await run(job.id);
    expect(await jobRow(job.id)).toMatchObject({ status: "failed", failure_code: "unreadable" });
    expect(await count("import_file")).toBe(0);
    expect(await count("usage_record")).toBe(0);
    expect((await inboxOf(job.id)).at(-1)).toMatchObject({
      type: "import.finished",
      status: "failed",
    });
  });

  it("erro inesperado → failed/internal, bytes apagados, evento confirmado (handle resolve)", async () => {
    const { job } = await upload(fixture("ofx", "conta-sgml-1252.ofx"));
    vi.spyOn(ingestion, "upsertTransactionsFor").mockRejectedValueOnce(
      new Error("falha com Padaria São João"),
    );
    await expect(run(job.id)).resolves.toBeUndefined();
    expect(await jobRow(job.id)).toMatchObject({ status: "failed", failure_code: "internal" });
    expect(await count("import_file")).toBe(0);
  });

  it("reenvio após stuck: lote 1 gravado, worker caiu → limpeza marca stuck → reenvio → done sem duplicar", async () => {
    const bytes = csv(1500, "Parcela");
    const { job } = await upload(bytes, GENERICO);
    const client = { id: await clientId(), externalId: "c1" };

    // O worker "morto": tomou o job, gravou o primeiro lote e parou.
    await TenantContext.run({ tenantId, clientId: client.id }, async () => {
      const claimed = must(await repo.claim(job.id), "claim");
      const parsed = runParser("csv", claimed.bytes, {
        format: "csv",
        csvPreset: "generico_br",
        institution: "Banco Exemplo",
        account: "cc",
      });
      await ingestion.upsertTransactionsFor(client, "import", parsed.transactions.slice(0, 1000));
    });
    await sql(
      `UPDATE import_job SET progress_at = now() - interval '20 minutes' WHERE tenant_id = $1`,
    );

    expect(await cleanup.run({ onlyTenants: [tenantId] })).toMatchObject({ stuck: 1 });
    expect(await jobRow(job.id)).toMatchObject({ status: "failed", failure_code: "stuck" });
    expect(await count("import_file")).toBe(0);
    expect((await inboxOf(job.id)).at(-1)).toMatchObject({
      type: "import.finished",
      status: "failed",
    });

    const again = await upload(bytes, GENERICO);
    expect(again).toMatchObject({ created: true, job: { id: job.id, status: "queued" } });
    await run(job.id);

    expect(await jobRow(job.id)).toMatchObject({ status: "done", failure_code: null });
    expect(await count("transaction", "AND source = 'import'")).toBe(1500);
    expect(await count("import_file")).toBe(0);
    expect(await count("import_job")).toBe(1);
  });

  it("worker travado (não morto) perde o job: stuck → reenvio → outro claim; o antigo não avança nem fecha", async () => {
    const bytes = csv(1500, "Travado");
    const { job } = await upload(bytes, GENERICO);
    const client = { id: await clientId(), externalId: "c1" };
    const pinned = <R>(fn: () => Promise<R>) =>
      TenantContext.run({ tenantId, clientId: client.id }, fn);

    // Worker A toma o job, grava o lote 1 e trava.
    const a = await pinned(async () => {
      const claimed = must(await repo.claim(job.id), "claim de A");
      const parsed = runParser("csv", claimed.bytes, {
        format: "csv",
        csvPreset: "generico_br",
        institution: "Banco Exemplo",
        account: "cc",
      });
      await ingestion.upsertTransactionsFor(client, "import", parsed.transactions.slice(0, 1000));
      expect(await repo.touchProgress(job.id, claimed.claimToken)).toBe(true);
      return claimed;
    });
    await sql(
      `UPDATE import_job SET progress_at = now() - interval '20 minutes' WHERE tenant_id = $1`,
    );
    expect(await cleanup.run({ onlyTenants: [tenantId] })).toMatchObject({ stuck: 1 });
    expect(await upload(bytes, GENERICO)).toMatchObject({ created: true });

    // Worker B (o real) toma o job; no meio da gravação dele, A acorda.
    const original = ingestion.upsertTransactionsFor.bind(ingestion);
    let checked = false;
    vi.spyOn(ingestion, "upsertTransactionsFor").mockImplementation(async (c, src, items) => {
      if (!checked) {
        checked = true;
        const usage = await count("usage_record");
        expect(await jobRow(job.id)).toMatchObject({ status: "parsing" });
        expect(await repo.touchProgress(job.id, a.claimToken)).toBe(false);
        const closed = await db.tx((tx) =>
          repo.finish(tx, job.id, a.claimToken, {
            status: "done",
            failureCode: null,
            stats: { rowsRead: 1, positions: 0, transactions: 1, errorRows: 0, ignored: {} },
            errors: [],
          }),
        );
        expect(closed).toBe(false);
        expect(await jobRow(job.id)).toMatchObject({ status: "parsing" });
        expect(await count("import_file")).toBe(1);
        expect(await count("usage_record")).toBe(usage);
      }
      return original(c, src, items);
    });
    await run(job.id);

    expect(checked).toBe(true);
    const row = await jobRow(job.id);
    expect(row).toMatchObject({ status: "done", failure_code: null });
    expect(row.stats).toMatchObject({ transactions: 1500 });
    expect(await count("transaction", "AND source = 'import'")).toBe(1500);
    expect(await count("import_file")).toBe(0);
    // 1 lote de A antes de travar + 2 lotes de B; nada de A depois do novo claim.
    expect(await count("usage_record")).toBe(3);
    expect(
      logged.some(
        (l) => typeof l === "object" && l !== null && "msg" in l && /tirado/.test(String(l.msg)),
      ),
    ).toBe(false);
  });

  it("import_file de 2 h → expired (job mantido, bytes apagados); arquivo recente intocado", async () => {
    const old = await upload(fixture("ofx", "conta-sgml-1252.ofx"));
    const fresh = await upload(fixture("ofx", "cartao-sgml.ofx"));
    await sql(
      `UPDATE import_file SET created_at = now() - interval '2 hours'
        WHERE tenant_id = $1 AND import_job_id = $2`,
      [old.job.id],
    );
    expect(await cleanup.run({ onlyTenants: [tenantId] })).toMatchObject({
      skipped: false,
      expired: 1,
      stuck: 0,
    });
    expect(await jobRow(old.job.id)).toMatchObject({ status: "failed", failure_code: "expired" });
    expect(await jobRow(fresh.job.id)).toMatchObject({ status: "queued" });
    expect(await count("import_job")).toBe(2);
    const files = await sql<{ import_job_id: string }>(
      `SELECT import_job_id FROM import_file WHERE tenant_id = $1`,
    );
    expect(files.map((f) => f.import_job_id)).toEqual([fresh.job.id]);
    expect((await inboxOf(old.job.id)).at(-1)).toMatchObject({
      type: "import.finished",
      status: "failed",
    });
    // O worker que pegar o evento do job expirado não tem o que fazer.
    await run(old.job.id);
    expect(await jobRow(old.job.id)).toMatchObject({ status: "failed", failure_code: "expired" });
  });

  it("limpeza: só enxerga tenants com trabalho; outro tenant não é tocado; lock global", async () => {
    const other = (await t.seedTenant({ name: "Outro" })).tenantId;
    const mine = await upload(fixture("ofx", "conta-sgml-1252.ofx"));
    const theirs = await upload(fixture("ofx", "conta-sgml-1252.ofx"), {}, other);
    await migratorSql(
      `UPDATE import_file SET created_at = now() - interval '2 hours' WHERE tenant_id = $1`,
      [other],
      { tenantId: other },
    );
    const ids = await db.importCleanupTenantIds(
      new Date(Date.now() - 60 * 60_000),
      new Date(Date.now() - 15 * 60_000),
    );
    expect(ids).toContain(other);
    expect(ids).not.toContain(tenantId);

    expect(await cleanup.run({ onlyTenants: [tenantId] })).toMatchObject({ expired: 0 });
    expect(await jobRow(mine.job.id)).toMatchObject({ status: "queued" });
    await redis.set("imports:cleanup", "outro-dono", "PX", 60_000);
    expect(await cleanup.run({ onlyTenants: [other] })).toMatchObject({ skipped: true });
    await redis.del("imports:cleanup");
    expect(await cleanup.run({ onlyTenants: [other] })).toMatchObject({ expired: 1 });
    const [theirRow] = await migratorSql<{ status: string }>(
      `SELECT status FROM import_job WHERE id = $1`,
      [theirs.job.id],
      { tenantId: other },
    );
    expect(theirRow?.status).toBe("failed");
  });

  it("nenhum log, erro de linha, auditoria ou evento contém a descrição de uma transação da fixture", async () => {
    const ofx = await upload(fixture("ofx", "conta-sgml-1252.ofx"));
    await run(ofx.job.id);
    const generico = await upload(fixture("csv", "generico-br.csv"), GENERICO);
    vi.spyOn(ingestion, "upsertTransactionsFor").mockRejectedValueOnce(
      new Error("violação com Padaria São João e Conta de luz"),
    );
    await run(generico.job.id);
    vi.restoreAllMocks();
    // Movimentação com tipos desconhecidos: as chaves de stats.ignored têm texto da célula.
    const b3 = await upload(fixture("xlsx", "b3-movimentacao.xlsx"));
    await run(b3.job.id);
    expect(await jobRow(b3.job.id)).toMatchObject({ status: "done" });
    await run(b3.job.id); // reentrega

    expect(await jobRow(generico.job.id)).toMatchObject({ failure_code: "internal" });
    const jobs = await sql<{ errors: unknown }>(
      `SELECT errors FROM import_job WHERE tenant_id = $1`,
    );
    const audit = await sql<{ query: string }>(
      `SELECT query FROM audit_event WHERE tenant_id = $1`,
    );
    const haystack = JSON.stringify([
      logged.map((l) => (l instanceof Error ? `${l.name}:${l.message}` : l)),
      logged.flatMap((l) =>
        typeof l === "object" && l !== null && "err" in l && l.err instanceof Error
          ? [l.err.message, l.err.stack]
          : [],
      ),
      await redis.xrange("jobs", "-", "+"),
      await redis.xrange("inbox.events", "-", "+"),
      jobs,
      audit,
    ]);
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of SECRETS) expect(haystack).not.toContain(secret);
  });
});
