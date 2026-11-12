/**
 * Sync (spec §6.4): posições e transações do cliente final viram documentos do conhecimento, pelo
 * `SyncWorker.syncClient` e pelo worker que consome `data.ingested` em `jobs` (grupo `sync`).
 *
 * Redis: DB lógico 8, esvaziado a cada teste. O worker só liga onde o teste pede
 * (`workersEnabled: true`); o padrão do createTestApp é desligado.
 */
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import { NotFoundError, ValidationError } from "../../src/core/errors/domain-errors.js";
import { StreamsService } from "../../src/core/redis/streams.service.js";
import { DataIngestionModule } from "../../src/modules/data-ingestion/data-ingestion.module.js";
import { IngestionService } from "../../src/modules/data-ingestion/ingestion.service.js";
import {
  cashFlowWindow,
  formatBrl,
  parseCents,
} from "../../src/modules/data-ingestion/sync-documents.js";
import { SYNC_LOGGER, SyncWorker } from "../../src/modules/data-ingestion/sync.worker.js";
import { generatePortfolio } from "../../src/modules/data-ingestion/synthetic/generator.js";
import { KnowledgeService } from "../../src/modules/knowledge/knowledge.service.js";
import { createTestApp, type SeededTenant, type TestApp } from "../setup/app.js";
import { migratorSql, redisDbUrl } from "../setup/db.js";

const REDIS_DB = 8;
const KG_TABLES = ["kg_document", "kg_chunk", "kg_entity", "kg_relation", "kg_mention"] as const;

async function until(cond: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout de ${ms} ms aguardando condição`);
}

/** Contagens das tabelas kg_* do cliente (como dono, com o contexto de RLS do cliente). */
async function kgCounts(tenantId: string, clientId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of KG_TABLES) {
    // Nome da tabela vem da lista fechada acima.
    const [row] = await migratorSql<{ n: string }>(`SELECT count(*) AS n FROM ${table}`, [], {
      tenantId,
      clientId,
    });
    out[table] = Number(row?.n ?? 0);
  }
  return out;
}

/** Conteúdo dos documentos do Sync, por título e posição do chunk (byte a byte). */
async function syncContent(tenantId: string, clientId: string): Promise<string[]> {
  const rows = await migratorSql<{ title: string; content: string }>(
    `SELECT d.title, c.content FROM kg_chunk c JOIN kg_document d ON d.id = c.document_id
      WHERE d.source = 'sync'
      ORDER BY convert_to(d.title, 'UTF8'), convert_to(c.content, 'UTF8')`,
    [],
    { tenantId, clientId },
  );
  return rows.map((r) => `${r.title}\u0000${r.content}`);
}

/** Texto inteiro de um documento do Sync, remontado sem a sobreposição (para checar totais). */
async function docText(tenantId: string, clientId: string, title: string): Promise<string> {
  const rows = await migratorSql<{ content: string }>(
    `SELECT c.content FROM kg_chunk c JOIN kg_document d ON d.id = c.document_id
      WHERE d.source = 'sync' AND d.title = $1`,
    [title],
    { tenantId, clientId },
  );
  return rows.map((r) => r.content).join("\n\n");
}

async function insertClient(tenantId: string, externalId: string): Promise<string> {
  const [row] = await migratorSql<{ id: string }>(
    `INSERT INTO client (tenant_id, external_id) VALUES ($1, $2) RETURNING id`,
    [tenantId, externalId],
    { tenantId },
  );
  if (!row) throw new Error("INSERT INTO client não devolveu id");
  return row.id;
}

async function clientIdOf(tenantId: string, externalId: string): Promise<string> {
  const [row] = await migratorSql<{ id: string }>(
    `SELECT id FROM client WHERE external_id = $1`,
    [externalId],
    { tenantId },
  );
  if (!row) throw new Error(`cliente ${externalId} não encontrado`);
  return row.id;
}

/** Ingere a carteira sintética pela API de ingestão (publica `data.ingested`). */
async function ingestSynthetic(
  ingestion: IngestionService,
  tenantId: string,
  externalId: string,
  seed: number,
): Promise<void> {
  const p = generatePortfolio("moderado", seed, "2026-11-10");
  await TenantContext.run({ tenantId }, async () => {
    await ingestion.upsertPositions(externalId, "synthetic", p.positions);
    await ingestion.upsertTransactions(externalId, "synthetic", p.transactions);
  });
}

describe("SyncWorker.syncClient", () => {
  let t: TestApp;
  let redis: Redis;
  let sync: SyncWorker;
  let ingestion: IngestionService;
  let knowledge: KnowledgeService;
  let A: SeededTenant;
  let B: SeededTenant;
  let aClient: string;
  let bClient: string;

  const asClient = <R>(tenantId: string, clientId: string, fn: () => Promise<R>) =>
    TenantContext.run({ tenantId, clientId }, fn);

  beforeAll(async () => {
    redis = new Redis(redisDbUrl(REDIS_DB));
    await redis.flushdb();
    t = await createTestApp({ imports: [DataIngestionModule], redisDb: REDIS_DB });
    sync = t.app.get(SyncWorker);
    ingestion = t.app.get(IngestionService);
    knowledge = t.app.get(KnowledgeService);
    A = await t.seedTenant({ name: "A" });
    B = await t.seedTenant({ name: "B" });
    await ingestSynthetic(ingestion, A.tenantId, "cli-moderado", 42);
    await ingestSynthetic(ingestion, B.tenantId, "cli-moderado", 7);
    aClient = await clientIdOf(A.tenantId, "cli-moderado");
    bClient = await clientIdOf(B.tenantId, "cli-moderado");
  });

  afterAll(async () => {
    await t.close();
    await redis.flushdb();
    redis.disconnect();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  it("o worker fica desligado por padrão no createTestApp (WORKERS_ENABLED=false)", async () => {
    expect(sync.running).toBe(false);
    // ninguém criou o grupo `sync` no stream jobs
    const groups = (await redis.xinfo("GROUPS", "jobs").catch(() => [])) as unknown[];
    expect(JSON.stringify(groups)).not.toContain('"sync"');
  });

  it('carteira sintética moderada: search("PETR4") traz a carteira e search("moradia") o fluxo', async () => {
    expect(await sync.syncClient(A.tenantId, aClient)).toEqual({ documents: 2 });

    const petr = await asClient(A.tenantId, aClient, () => knowledge.search("PETR4"));
    const carteira = petr.chunks.find((c) => c.title === "Carteira consolidada");
    expect(carteira?.content).toMatch(/\d+ PETR4 \(ação\) na (XP|BTG): R\$ [\d.]+,\d{2}/);
    expect(petr.entities).toContainEqual(expect.objectContaining({ type: "ativo", name: "PETR4" }));
    // relações do grafo: custódia, classe e posse (a busca devolve só os 20 vizinhos mais
    // próximos, então a conferência é no banco)
    const rels = await migratorSql<{ s: string; type: string; t: string }>(
      `SELECT s.type || ':' || s.name AS s, r.type, t.type || ':' || t.name AS t
         FROM kg_relation r
         JOIN kg_entity s ON s.id = r.source_id
         JOIN kg_entity t ON t.id = r.target_id
        WHERE (s.type = 'ativo' AND s.name = 'PETR4') OR (t.type = 'ativo' AND t.name = 'PETR4')`,
      [],
      { tenantId: A.tenantId, clientId: aClient },
    );
    expect(rels.map((r) => `${r.s} ${r.type} ${r.t}`).sort()).toEqual([
      expect.stringMatching(/^ativo:PETR4 CUSTODIADO_EM instituicao:(XP|BTG)$/),
      "ativo:PETR4 DA_CLASSE classe:acao",
      "cliente:self POSSUI ativo:PETR4",
    ]);

    const moradia = await asClient(A.tenantId, aClient, () => knowledge.search("moradia"));
    const fluxo = moradia.chunks.find((c) => c.title === "Fluxo de caixa 12 meses");
    expect(fluxo?.content).toContain("moradia");
    expect(moradia.entities).toContainEqual(
      expect.objectContaining({ type: "categoria", name: "moradia" }),
    );

    const text = await docText(A.tenantId, aClient, "Fluxo de caixa 12 meses");
    expect(text).toMatch(/Recorrência "Aluguel e condomínio": 12 meses/);
    expect(text).toMatch(/Parcelamento "Notebook" em 10x: 10 parcelas no período \(1 a 10\)/);
  });

  it("rodar o Sync duas vezes não duplica nada e gera o mesmo conteúdo byte a byte", async () => {
    await sync.syncClient(A.tenantId, aClient);
    const counts = await kgCounts(A.tenantId, aClient);
    const content = await syncContent(A.tenantId, aClient);
    expect(counts["kg_document"]).toBe(2);

    expect(await sync.syncClient(A.tenantId, aClient)).toEqual({ documents: 2 });
    expect(await kgCounts(A.tenantId, aClient)).toEqual(counts);
    expect(await syncContent(A.tenantId, aClient)).toEqual(content);
  });

  it("isolamento: o Sync do cliente de A nunca cria nada visível para B", async () => {
    await sync.syncClient(A.tenantId, aClient);
    const bBefore = await kgCounts(B.tenantId, bClient);
    await sync.syncClient(A.tenantId, aClient);
    expect(await kgCounts(B.tenantId, bClient)).toEqual(bBefore);

    // tenant B com o id interno do cliente de A: cliente desconhecido, nada é escrito
    await expect(sync.syncClient(B.tenantId, aClient)).rejects.toBeInstanceOf(NotFoundError);
    expect(await kgCounts(B.tenantId, aClient)).toEqual(
      Object.fromEntries(KG_TABLES.map((k) => [k, 0])),
    );

    // B sincroniza os próprios dados e não vê os de A (as carteiras têm seeds diferentes)
    await sync.syncClient(B.tenantId, bClient);
    const aText = await docText(A.tenantId, aClient, "Carteira consolidada");
    const bText = await docText(B.tenantId, bClient, "Carteira consolidada");
    expect(bText).not.toBe(aText);
    const bDocs = await migratorSql<{ id: string }>(`SELECT id FROM kg_document`, [], {
      tenantId: B.tenantId,
      clientId: bClient,
    });
    const res = await asClient(B.tenantId, bClient, () =>
      knowledge.search("Carteira PETR4", { k: 50 }),
    );
    expect(res.chunks.length).toBeGreaterThan(0);
    expect(res.chunks.every((c) => bDocs.some((d) => d.id === c.documentId))).toBe(true);
  });

  it("valida ids: não-uuid é ValidationError; cliente inexistente é NotFoundError", async () => {
    await expect(sync.syncClient("x", aClient)).rejects.toBeInstanceOf(ValidationError);
    await expect(sync.syncClient(A.tenantId, "y")).rejects.toBeInstanceOf(ValidationError);
    await expect(sync.syncClient(A.tenantId, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("cliente sem dados: nenhum documento", async () => {
    const empty = await insertClient(A.tenantId, "sem-dados");
    expect(await sync.syncClient(A.tenantId, empty)).toEqual({ documents: 0 });
    expect((await kgCounts(A.tenantId, empty))["kg_document"]).toBe(0);
  });

  it("cliente com ≥ 2.500 posições e ≥ 2.500 transações em várias fontes: totais exatos", async () => {
    const big = await insertClient(A.tenantId, "grande");
    const ctx = { tenantId: A.tenantId };
    // Mesmos códigos de ativo em duas fontes (api e import): somados, não deduplicados.
    await migratorSql(
      `INSERT INTO position (tenant_id, client_id, source, external_id, institution, kind,
         asset_class, asset_code, name, quantity, value_brl, as_of)
       SELECT $1, $2, src, 'p' || lpad(i::text, 5, '0'),
              (ARRAY['xp','btg','itau'])[1 + i % 3], 'investment',
              (ARRAY['acao','fii','tesouro','renda_fixa','fundo'])[1 + i % 5],
              'at' || lpad((i % 1700)::text, 4, '0'), 'ativo ' || i, (1 + i % 97)::numeric,
              ((i * 7919) % 9999999)::numeric / 100 + 0.01, date '2026-11-10'
       FROM generate_series(0, 1299) AS i, unnest(ARRAY['api', 'import']) AS src`,
      [A.tenantId, big],
      ctx,
    );
    // 2.600 transações em 15 meses, com sinal: entradas e saídas de vários tipos.
    await migratorSql(
      `INSERT INTO "transaction" (tenant_id, client_id, source, external_id, institution, account,
         date, description, amount_brl, category, kind)
       SELECT $1, $2, src, 't' || lpad(i::text, 5, '0'), 'itau', 'cc',
              date '2025-09-01' + (i % 450),
              'lancamento ' || (i % 40),
              CASE WHEN i % 3 = 0 THEN ((i * 31) % 500000)::numeric / 100 + 0.07
                   ELSE -(((i * 17) % 300000)::numeric / 100 + 0.03) END,
              (ARRAY['moradia','saude','lazer','mercado','transporte','tarifas'])[1 + i % 6],
              CASE WHEN i % 3 = 0 THEN 'credit' WHEN i % 7 = 0 THEN 'fee' ELSE 'debit' END
       FROM generate_series(0, 1299) AS i, unnest(ARRAY['api', 'synthetic']) AS src`,
      [A.tenantId, big],
      ctx,
    );

    expect(await sync.syncClient(A.tenantId, big)).toEqual({ documents: 2 });

    const carteira = await docText(A.tenantId, big, "Carteira consolidada");
    const [total] = await migratorSql<{ s: string; n: string }>(
      `SELECT sum(value_brl)::text AS s, count(*)::text AS n FROM position WHERE client_id = $1`,
      [big],
      { tenantId: A.tenantId, clientId: big },
    );
    expect(carteira).toContain(`${total?.n} posições`);
    expect(carteira).toContain(`patrimônio total ${formatBrl(parseCents(total?.s ?? ""))}`);
    const classes = await migratorSql<{ c: string; s: string }>(
      `SELECT asset_class AS c, sum(value_brl)::text AS s FROM position WHERE client_id = $1
        GROUP BY asset_class`,
      [big],
      { tenantId: A.tenantId, clientId: big },
    );
    expect(classes).toHaveLength(5);
    for (const { c, s } of classes) {
      expect(carteira).toMatch(
        new RegExp(
          `Classe ${c} \\([^)]+\\): [\\d,]+% do patrimônio, ${escape(formatBrl(parseCents(s)))}\\.`,
        ),
      );
    }
    // cada ativo veio de duas fontes: 1.300 linhas agregadas, 30 listadas e o resto resumido
    expect(carteira).toContain("Demais 1270 posições: ");
    const fluxo = await docText(A.tenantId, big, "Fluxo de caixa 12 meses");
    const [newest] = await migratorSql<{ d: string }>(
      `SELECT to_char(max(date), 'YYYY-MM-DD') AS d FROM "transaction" WHERE client_id = $1`,
      [big],
      { tenantId: A.tenantId, clientId: big },
    );
    const window = cashFlowWindow(newest?.d ?? "");
    const months = await migratorSql<{ m: string; i: string; o: string }>(
      `SELECT to_char(date, 'YYYY-MM') AS m,
              coalesce(sum(amount_brl) FILTER (WHERE amount_brl > 0), 0)::text AS i,
              coalesce(-sum(amount_brl) FILTER (WHERE amount_brl < 0), 0)::text AS o
         FROM "transaction" WHERE client_id = $1 AND date >= $2::date
        GROUP BY 1`,
      [big, window.from],
      { tenantId: A.tenantId, clientId: big },
    );
    expect(months.map((m) => m.m).sort()).toEqual(window.months);
    let inflow = 0n;
    let outflow = 0n;
    for (const m of months) {
      const i = parseCents(m.i);
      const o = parseCents(m.o);
      inflow += i;
      outflow += o;
      expect(fluxo).toContain(
        `Mês ${m.m}: entradas ${formatBrl(i)}, saídas ${formatBrl(o)}, saldo ${formatBrl(i - o)}.`,
      );
    }
    expect(fluxo).toContain(
      `Entradas: ${formatBrl(inflow)}. Saídas: ${formatBrl(outflow)}. Saldo: ${formatBrl(inflow - outflow)}.`,
    );
    // texto resumido: tamanho limitado mesmo com milhares de linhas
    expect(carteira.length).toBeLessThan(8000);
    expect(fluxo.length).toBeLessThan(12000);
  });
});

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("SyncWorker consumindo jobs (grupo sync)", () => {
  let redis: Redis;
  let t: TestApp | undefined;
  const logger = { warn: vi.fn(), error: vi.fn() };

  beforeAll(() => {
    redis = new Redis(redisDbUrl(REDIS_DB));
  });
  afterAll(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  beforeEach(async () => {
    await redis.flushdb();
    logger.warn.mockClear();
    logger.error.mockClear();
  });
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  const start = async (workersEnabled: boolean) => {
    t = await createTestApp({
      imports: [DataIngestionModule],
      redisDb: REDIS_DB,
      workersEnabled,
      overrides: [{ token: SYNC_LOGGER, useValue: logger }],
    });
    return t;
  };

  const docCount = async (tenantId: string, clientId: string) =>
    Number(
      (
        await migratorSql<{ n: string }>(
          `SELECT count(*) AS n FROM kg_document WHERE source = 'sync'`,
          [],
          { tenantId, clientId },
        )
      )[0]?.n ?? 0,
    );

  const pendingSync = async () => {
    const [count] = (await redis.xpending("jobs", "sync")) as [number, ...unknown[]];
    return count;
  };

  it("data.ingested publicado pela ingestão faz o worker sincronizar o cliente", async () => {
    const app = await start(true);
    expect(app.app.get(SyncWorker).running).toBe(true);
    const T = await app.seedTenant();
    await ingestSynthetic(app.app.get(IngestionService), T.tenantId, "cli-evento", 3);
    const client = await clientIdOf(T.tenantId, "cli-evento");
    await until(async () => (await docCount(T.tenantId, client)) === 2);
    await until(async () => (await pendingSync()) === 0);
  });

  it("outros tipos de evento são ignorados e confirmados (ACK)", async () => {
    const app = await start(true);
    const T = await app.seedTenant();
    const client = await insertClient(T.tenantId, "cli-outro");
    const streams = app.app.get(StreamsService);
    await streams.publish("jobs", {
      eventId: randomUUID(),
      type: "notification",
      tenantId: T.tenantId,
      clientId: client,
      kind: "info",
      text: "olá",
    });
    await streams.publish("jobs", {
      eventId: randomUUID(),
      type: "approval.created",
      tenantId: T.tenantId,
      clientId: client,
      approvalId: "a1",
    });
    await until(async () => {
      const groups = (await redis.xinfo("GROUPS", "jobs")) as unknown[][];
      const sync = groups.find((g) => g[1] === "sync");
      const entriesRead = sync ? Number(sync[sync.indexOf("entries-read") + 1]) : 0;
      return entriesRead === 2 && (await pendingSync()) === 0;
    });
    expect(await docCount(T.tenantId, client)).toBe(0);
    expect(await redis.xlen("jobs.dlq")).toBe(0);
  });

  it("evento malformado ou de cliente desconhecido não derruba o loop (DLQ/ACK + log)", async () => {
    const app = await start(true);
    const T = await app.seedTenant();
    const streams = app.app.get(StreamsService);
    // JSON inválido: o StreamsService manda para a DLQ
    await redis.xadd("jobs", "*", "data", "{nao é json");
    // ids que não são uuid e cliente que não existe no tenant: log + ACK
    await streams.publish("jobs", {
      eventId: randomUUID(),
      type: "data.ingested",
      tenantId: "nao-e-uuid",
      clientId: "x",
      source: "api",
    });
    await streams.publish("jobs", {
      eventId: randomUUID(),
      type: "data.ingested",
      tenantId: T.tenantId,
      clientId: randomUUID(),
      source: "api",
    });
    // e o loop segue vivo: um evento válido depois disso é processado
    await ingestSynthetic(app.app.get(IngestionService), T.tenantId, "cli-depois", 5);
    const client = await clientIdOf(T.tenantId, "cli-depois");
    await until(async () => (await docCount(T.tenantId, client)) === 2);
    await until(async () => (await pendingSync()) === 0);
    expect(await redis.xlen("jobs.dlq")).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    for (const [fields] of logger.warn.mock.calls as [Record<string, unknown>][]) {
      expect(fields).toEqual(
        expect.objectContaining({ msg: expect.any(String), err: expect.any(Error) }),
      );
    }
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("WORKERS_ENABLED=false não liga o consumo; o encerramento para o worker limpo", async () => {
    const off = await start(false);
    const T = await off.seedTenant();
    const worker = off.app.get(SyncWorker);
    expect(worker.running).toBe(false);
    await ingestSynthetic(off.app.get(IngestionService), T.tenantId, "cli-off", 9);
    const client = await clientIdOf(T.tenantId, "cli-off");
    await new Promise((r) => setTimeout(r, 300));
    expect(await docCount(T.tenantId, client)).toBe(0);
    const groups = (await redis.xinfo("GROUPS", "jobs")) as unknown[][];
    expect(groups.some((g) => g[1] === "sync")).toBe(false);
    await off.close();
    t = undefined;

    const on = await start(true);
    const running = on.app.get(SyncWorker);
    expect(running.running).toBe(true);
    // o worker liga e processa o evento que ficou no stream
    await until(async () => (await docCount(T.tenantId, client)) === 2);
    const began = Date.now();
    await on.close();
    t = undefined;
    expect(running.running).toBe(false);
    expect(Date.now() - began).toBeLessThan(3000);
  });
});
