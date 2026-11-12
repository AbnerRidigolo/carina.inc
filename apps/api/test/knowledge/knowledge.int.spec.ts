import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantContext } from "../../src/core/context/tenant-context.js";
import { PrismaService } from "../../src/core/database/prisma.service.js";
import { TenantPrismaService } from "../../src/core/database/tenant-prisma.service.js";
import { UnauthenticatedError, ValidationError } from "../../src/core/errors/domain-errors.js";
import { KnowledgeModule } from "../../src/modules/knowledge/knowledge.module.js";
import { KnowledgeRepository } from "../../src/modules/knowledge/knowledge.repository.js";
import { KnowledgeService } from "../../src/modules/knowledge/knowledge.service.js";
import { HashEmbeddings } from "../../src/modules/llm/hash-embeddings.js";
import type { ModelFactory } from "../../src/modules/llm/model-factory.js";
import { createTestApp } from "../setup/app.js";
import { appUrl, migratorSql } from "../setup/db.js";

const REDIS_DB = 14;

/** ModelFactory mínimo: só `embeddings()`, com os embeddings determinísticos do modo mock. */
function fakeFactory(embeddings = new HashEmbeddings(1024)): ModelFactory {
  return { embeddings: () => embeddings } as unknown as ModelFactory;
}

/** Embeddings que contam as chamadas (para conferir que a ingestão usa um único lote). */
class CountingEmbeddings extends HashEmbeddings {
  documentCalls = 0;
  queryCalls = 0;
  override async embedDocuments(texts: string[]): Promise<number[][]> {
    this.documentCalls++;
    return super.embedDocuments(texts);
  }
  override async embedQuery(text: string): Promise<number[]> {
    this.queryCalls++;
    return super.embedQuery(text);
  }
}

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

describe("KnowledgeService (carina_app, sob RLS)", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const clientA1 = randomUUID();
  const clientA2 = randomUUID();
  const clientA3 = randomUUID();
  const clientA4 = randomUUID();
  const clientB1 = randomUUID();
  let prisma: PrismaService;
  let db: TenantPrismaService;
  let repo: KnowledgeRepository;
  let knowledge: KnowledgeService;

  const as = <T>(tenantId: string, clientId: string, fn: () => Promise<T>) =>
    TenantContext.run({ tenantId, clientId }, fn);
  const inA1 = <T>(fn: () => Promise<T>) => as(tenantA, clientA1, fn);
  const inA2 = <T>(fn: () => Promise<T>) => as(tenantA, clientA2, fn);

  /** Conta linhas de uma tabela kg_* do cliente, como dono (com o contexto de RLS do cliente). */
  async function count(
    table: "kg_document" | "kg_chunk" | "kg_entity" | "kg_relation" | "kg_mention",
    tenantId: string,
    clientId: string,
  ): Promise<number> {
    // Nome da tabela vem do tipo fechado acima (nunca de entrada).
    const [row] = await migratorSql<{ n: string }>(`SELECT count(*) AS n FROM ${table}`, [], {
      tenantId,
      clientId,
    });
    return Number(row?.n ?? 0);
  }

  beforeAll(async () => {
    await migratorSql(
      `INSERT INTO tenant (id, name, plan) VALUES ($1, 'A', 'pro'), ($2, 'B', 'pro')`,
      [tenantA, tenantB],
    );
    for (const [id, ext] of [
      [clientA1, "a1"],
      [clientA2, "a2"],
      [clientA3, "a3"],
      [clientA4, "a4"],
    ] as const) {
      await migratorSql(
        `INSERT INTO client (id, tenant_id, external_id) VALUES ($1, $2, $3)`,
        [id, tenantA, ext],
        { tenantId: tenantA },
      );
    }
    await migratorSql(
      `INSERT INTO client (id, tenant_id, external_id) VALUES ($1, $2, 'b1')`,
      [clientB1, tenantB],
      { tenantId: tenantB },
    );
    prisma = new PrismaService({ DATABASE_URL: appUrl() });
    db = new TenantPrismaService(prisma);
    repo = new KnowledgeRepository();
    knowledge = new KnowledgeService(db, repo, fakeFactory());

    // Dados do cliente A1: a carteira com PETR4 na XP e a relação de custódia.
    await inA1(() =>
      knowledge.ingestDocument({
        source: "sync:xp",
        title: "Carteira XP",
        text: "Carteira: 500 ações PETR4 na XP",
        entities: [
          { type: "ativo", name: "PETR4", properties: { ticker: "PETR4" } },
          { type: "instituicao", name: "XP" },
        ],
        relations: [
          { sourceRef: "ativo:PETR4", targetRef: "instituicao:XP", type: "CUSTODIADO_EM" },
        ],
        mentions: ["ativo:PETR4", "instituicao:XP"],
      }),
    );
    await inA1(() =>
      knowledge.ingestDocument({
        source: "nota",
        title: "Anotações gerais",
        text: "Reunião sobre renda fixa e tesouro direto com o assessor.",
      }),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('search("PETR4") traz o chunk da carteira em primeiro, com citação e a entidade ativo:PETR4', async () => {
    const res = await inA1(() => knowledge.search("PETR4"));
    const first = res.chunks[0];
    expect(first).toBeDefined();
    expect(first?.content).toBe("Carteira: 500 ações PETR4 na XP");
    expect(first?.title).toBe("Carteira XP");
    expect(first?.chunkId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first?.documentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first?.score).toBeGreaterThan(0);
    // ordenado por score decrescente
    const scores = res.chunks.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    expect(res.entities).toContainEqual({
      type: "ativo",
      name: "PETR4",
      properties: { ticker: "PETR4" },
    });
    expect(res.entities).toContainEqual({ type: "instituicao", name: "XP", properties: {} });
  });

  it("a relação ativo:PETR4 -[CUSTODIADO_EM]-> instituicao:XP aparece em neighbors", async () => {
    const res = await inA1(() => knowledge.search("PETR4"));
    expect(res.neighbors).toContainEqual({
      from: "ativo:PETR4",
      type: "CUSTODIADO_EM",
      to: "instituicao:XP",
    });
  });

  it("vizinhança vai até 2 saltos (não 3) e é limitada a 20", async () => {
    const t = tenantA;
    const c = clientA4;
    // Cadeia: alpha -[R1]-> beta -[R2]-> gamma -[R3]-> delta; e alpha -[MUITOS]-> 25 alvos
    await as(t, c, () =>
      knowledge.ingestDocument({
        source: "grafo",
        title: "Cadeia",
        text: "Documento sobre alpha.",
        entities: [
          { type: "no", name: "alpha" },
          { type: "no", name: "beta" },
          { type: "no", name: "gamma" },
          { type: "no", name: "delta" },
        ],
        relations: [
          { sourceRef: "no:alpha", targetRef: "no:beta", type: "R1" },
          { sourceRef: "no:beta", targetRef: "no:gamma", type: "R2" },
          { sourceRef: "no:gamma", targetRef: "no:delta", type: "R3" },
        ],
        mentions: ["no:alpha"],
      }),
    );
    const near = await as(t, c, () => knowledge.search("alpha"));
    expect(near.entities.map((e) => e.name)).toEqual(["alpha"]);
    expect(near.neighbors).toEqual([
      { from: "no:alpha", type: "R1", to: "no:beta" },
      { from: "no:beta", type: "R2", to: "no:gamma" },
    ]);

    await as(t, c, () =>
      knowledge.ingestDocument({
        source: "grafo",
        title: "Muitos",
        text: "Outro documento sobre alpha e seus alvos.",
        entities: Array.from({ length: 25 }, (_, i) => ({ type: "alvo", name: `t${i}` })),
        relations: Array.from({ length: 25 }, (_, i) => ({
          sourceRef: "no:alpha",
          targetRef: `alvo:t${i}`,
          type: "MUITOS",
        })),
        mentions: ["no:alpha"],
      }),
    );
    const many = await as(t, c, () => knowledge.search("alpha"));
    expect(many.neighbors).toHaveLength(20);
    // saltos de 1 vêm antes dos de 2
    expect(many.neighbors.some((n) => n.type === "R2")).toBe(false);
  });

  it("cliente A2 do mesmo tenant não vê chunks, entidades nem vizinhos de A1 (spec §9)", async () => {
    // A2 tem dados próprios, para a busca não ficar vazia só por falta de dados.
    await inA2(() =>
      knowledge.ingestDocument({
        source: "sync:btg",
        title: "Carteira BTG",
        text: "Carteira: 200 cotas de fundo imobiliário HGLG11 no BTG",
        entities: [{ type: "ativo", name: "HGLG11" }],
        mentions: ["ativo:HGLG11"],
      }),
    );
    const res = await inA2(() => knowledge.search("PETR4"));
    // a busca devolve dados de A2 (o ranker vetorial sempre traz candidatos), mas nada de A1
    expect(res.chunks.map((c) => c.title)).toEqual(["Carteira BTG"]);
    expect(res.chunks.every((c) => !c.content.includes("PETR4"))).toBe(true);
    expect(res.chunks.map((c) => c.title)).not.toContain("Carteira XP");
    expect(res.entities.map((e) => e.name)).not.toContain("PETR4");
    expect(res.neighbors.filter((n) => n.from.includes("PETR4") || n.to.includes("PETR4"))).toEqual(
      [],
    );
    // Um cliente sem nenhum dado não vê nada.
    const empty = await as(tenantA, clientA3, () => knowledge.search("PETR4"));
    expect(empty).toEqual({ chunks: [], entities: [], neighbors: [] });
  });

  it("outro tenant não vê nada de A1, nem com um client_id de A1 forjado no contexto", async () => {
    const res = await as(tenantB, clientB1, () => knowledge.search("PETR4 XP Carteira"));
    expect(res).toEqual({ chunks: [], entities: [], neighbors: [] });
    // tenant B com o client_id de A1: o RLS exige os dois, então continua vazio
    const forged = await as(tenantB, clientA1, () => knowledge.search("PETR4"));
    expect(forged).toEqual({ chunks: [], entities: [], neighbors: [] });
  });

  it("sem cliente fixado, search e ingestDocument falham fechado com ValidationError", async () => {
    const tenantOnly = <T>(fn: () => Promise<T>) => TenantContext.run({ tenantId: tenantA }, fn);
    await expect(tenantOnly(() => knowledge.search("PETR4"))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      tenantOnly(() => knowledge.ingestDocument({ source: "x", title: "y", text: "PETR4" })),
    ).rejects.toBeInstanceOf(ValidationError);
    // sem contexto nenhum
    await expect(knowledge.search("PETR4")).rejects.toBeInstanceOf(UnauthenticatedError);
    // e, abaixo do serviço, o RLS sozinho também não devolve nada sem cliente
    const rows = await tenantOnly(() =>
      db.tx((tx) =>
        repo.searchChunks(tx, { text: "PETR4", vector: new HashEmbeddings().embed("PETR4"), k: 6 }),
      ),
    );
    expect(rows).toEqual([]);
  });

  it("query vazia ou só com espaços devolve resultado vazio, sem erro e sem embedding", async () => {
    const emb = new CountingEmbeddings();
    const svc = new KnowledgeService(db, repo, fakeFactory(emb));
    for (const q of ["", "   ", "\n\t "]) {
      expect(await inA1(() => svc.search(q))).toEqual({ chunks: [], entities: [], neighbors: [] });
    }
    expect(emb.queryCalls).toBe(0);
  });

  it("valida k", async () => {
    await expect(inA1(() => knowledge.search("PETR4", { k: 0 }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(inA1(() => knowledge.search("PETR4", { k: 1.5 }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    const one = await inA1(() => knowledge.search("PETR4", { k: 1 }));
    expect(one.chunks).toHaveLength(1);
  });

  it("texto da busca com sintaxe de websearch/aspas/SQL é só dado (parâmetro), não quebra", async () => {
    for (const q of [`'; DROP TABLE kg_chunk; --`, `"PETR4" OR -XP`, `PETR4 & | ! :*`]) {
      const res = await inA1(() => knowledge.search(q));
      expect(Array.isArray(res.chunks)).toBe(true);
    }
    expect(await count("kg_chunk", tenantA, clientA1)).toBeGreaterThan(0);
  });

  it("RRF: um chunk achado pelos dois rankers supera um achado só pelo vetorial", async () => {
    const t = tenantA;
    const c = clientA3;
    // Só stopwords: o full-text ignora, mas o embedding lexical fica muito perto da consulta.
    const onlyVector = "de para com sem";
    const both = "Os dividendos pagos pela empresa no trimestre superaram a expectativa do mercado";
    const query = "dividendos de para com";
    const h = new HashEmbeddings();
    const q = h.embed(query);
    // sanidade do cenário: pelo vetor, `onlyVector` está mais perto que `both`
    expect(cosine(q, h.embed(onlyVector))).toBeGreaterThan(cosine(q, h.embed(both)));

    await as(t, c, () => knowledge.ingestDocument({ source: "rrf", title: "V", text: onlyVector }));
    await as(t, c, () => knowledge.ingestDocument({ source: "rrf", title: "B", text: both }));

    const res = await as(t, c, () => knowledge.search(query));
    expect(res.chunks.map((x) => x.title)).toEqual(["B", "V"]);
    const [b, v] = res.chunks;
    // B: vetor rank 2 + full-text rank 1; V: vetor rank 1, fora do full-text
    expect(b?.score).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(v?.score).toBeCloseTo(1 / 61, 10);
  });

  it("reingerir o mesmo (source, title) substitui os chunks: sem duplicatas nem órfãos", async () => {
    const t = tenantA;
    const c = clientA2;
    const input = {
      source: "sync:btg",
      title: "Extrato",
      text: "Extrato com aplicação em CDB do banco BTG.\n\nResgate parcial de LCI.",
      entities: [
        { type: "ativo", name: "CDB" },
        { type: "instituicao", name: "BTG" },
      ],
      relations: [{ sourceRef: "ativo:CDB", targetRef: "instituicao:BTG", type: "CUSTODIADO_EM" }],
    };
    const first = await as(t, c, () => knowledge.ingestDocument(input));
    const before = {
      docs: await count("kg_document", t, c),
      chunks: await count("kg_chunk", t, c),
      entities: await count("kg_entity", t, c),
      relations: await count("kg_relation", t, c),
      mentions: await count("kg_mention", t, c),
    };
    const second = await as(t, c, () => knowledge.ingestDocument(input));
    expect(second.documentId).toBe(first.documentId);
    expect(second.chunkIds).toHaveLength(first.chunkIds.length);
    expect(second.chunkIds.some((id) => first.chunkIds.includes(id))).toBe(false);
    expect({
      docs: await count("kg_document", t, c),
      chunks: await count("kg_chunk", t, c),
      entities: await count("kg_entity", t, c),
      relations: await count("kg_relation", t, c),
      mentions: await count("kg_mention", t, c),
    }).toEqual(before);

    // Nada aponta para os chunks antigos; nenhuma relação ficou sem chunk (ON DELETE SET NULL).
    const [orphans] = await migratorSql<{ m: string; r: string; rnull: string }>(
      `SELECT
         (SELECT count(*) FROM kg_mention WHERE chunk_id = ANY($1::uuid[])) AS m,
         (SELECT count(*) FROM kg_relation WHERE chunk_id = ANY($1::uuid[])) AS r,
         (SELECT count(*) FROM kg_relation WHERE chunk_id IS NULL) AS rnull`,
      [first.chunkIds],
      { tenantId: t, clientId: c },
    );
    expect(orphans).toEqual({ m: "0", r: "0", rnull: "0" });

    // Conteúdo novo substitui o antigo
    await as(t, c, () => knowledge.ingestDocument({ ...input, text: "Extrato só com LCA." }));
    const res = await as(t, c, () => knowledge.search("CDB aplicação"));
    expect(res.chunks.map((x) => x.content).join(" ")).not.toContain("aplicação em CDB");
    const [n] = await migratorSql<{ n: string }>(
      `SELECT count(*) AS n FROM kg_chunk ch JOIN kg_document d ON d.id = ch.document_id
        WHERE d.source = 'sync:btg' AND d.title = 'Extrato'`,
      [],
      { tenantId: t, clientId: c },
    );
    expect(n?.n).toBe("1");
  });

  it("ingestão é atômica: falha no meio (ref desconhecida) não deixa nada para trás", async () => {
    const t = tenantA;
    const c = clientA2;
    const before = {
      docs: await count("kg_document", t, c),
      chunks: await count("kg_chunk", t, c),
      entities: await count("kg_entity", t, c),
    };
    await expect(
      as(t, c, () =>
        knowledge.ingestDocument({
          source: "atomico",
          title: "Falha",
          text: "Documento que não pode ficar pela metade.",
          entities: [{ type: "ativo", name: "NOVA3" }],
          relations: [
            { sourceRef: "ativo:NOVA3", targetRef: "instituicao:INEXISTENTE", type: "X" },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect({
      docs: await count("kg_document", t, c),
      chunks: await count("kg_chunk", t, c),
      entities: await count("kg_entity", t, c),
    }).toEqual(before);

    // Reingestão que falha mantém a versão anterior intacta.
    const ok = await as(t, c, () =>
      knowledge.ingestDocument({
        source: "atomico",
        title: "Versão",
        text: "Versão boa do texto.",
      }),
    );
    await expect(
      as(t, c, () =>
        knowledge.ingestDocument({
          source: "atomico",
          title: "Versão",
          text: "Versão ruim.",
          mentions: ["ativo:NAO_EXISTE"],
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    const rows = await migratorSql<{ id: string; content: string }>(
      `SELECT id, content FROM kg_chunk WHERE document_id = $1`,
      [ok.documentId],
      { tenantId: t, clientId: c },
    );
    expect(rows).toEqual([{ id: ok.chunkIds[0], content: "Versão boa do texto." }]);
  });

  it('entidades são upsert por (type, name), com embedding de "<type> <name>" e ref type:name', async () => {
    const t = tenantA;
    const c = clientA3;
    await as(t, c, () =>
      knowledge.ingestDocument({
        source: "ent",
        title: "E1",
        text: "Posição em VALE3.",
        entities: [{ type: "ativo", name: "VALE3", properties: { setor: "mineração" } }],
      }),
    );
    await as(t, c, () =>
      knowledge.ingestDocument({
        source: "ent",
        title: "E2",
        text: "Mais VALE3.",
        entities: [{ type: "ativo", name: "VALE3", properties: { bolsa: "B3" } }],
      }),
    );
    const rows = await migratorSql<{ properties: object; emb: string }>(
      `SELECT properties, embedding::text AS emb FROM kg_entity WHERE type = 'ativo' AND name = 'VALE3'`,
      [],
      { tenantId: t, clientId: c },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.properties).toEqual({ setor: "mineração", bolsa: "B3" });
    const stored = JSON.parse(rows[0]?.emb ?? "[]") as number[];
    const expected = new HashEmbeddings().embed("ativo VALE3");
    expect(stored).toHaveLength(1024);
    stored.forEach((x, i) => expect(x).toBeCloseTo(expected[i] ?? NaN, 6));

    // sem `mentions`, as entidades do documento contam como mencionadas nele
    const res = await as(t, c, () => knowledge.search("VALE3"));
    expect(res.entities).toContainEqual({
      type: "ativo",
      name: "VALE3",
      properties: { setor: "mineração", bolsa: "B3" },
    });
  });

  it("ingestão calcula todos os embeddings num único lote (embedDocuments)", async () => {
    const emb = new CountingEmbeddings();
    const svc = new KnowledgeService(db, repo, fakeFactory(emb));
    const text = Array.from({ length: 6 }, (_, i) => `Parágrafo ${i} `.repeat(30)).join("\n\n");
    const out = await as(tenantA, clientA3, () =>
      svc.ingestDocument({
        source: "lote",
        title: "Lote",
        text,
        entities: [
          { type: "ativo", name: "ITUB4" },
          { type: "ativo", name: "BBAS3" },
        ],
      }),
    );
    expect(out.chunkIds.length).toBeGreaterThan(1);
    expect(emb.documentCalls).toBe(1);
    expect(emb.queryCalls).toBe(0);
  });

  it("valida a entrada da ingestão", async () => {
    const bad = [
      { source: "", title: "t", text: "x" },
      { source: "s", title: " ", text: "x" },
      { source: "s", title: "t", text: "   " },
      { source: "s", title: "t", text: "x", entities: [{ type: "a:b", name: "n" }] },
      { source: "s", title: "t", text: "x", entities: [{ type: "a", name: "" }] },
      { source: "s", title: "t", text: "x", mentions: ["sem-dois-pontos"] },
      {
        source: "s",
        title: "t",
        text: "x",
        relations: [{ sourceRef: "a:b", targetRef: "a:c", type: "" }],
      },
    ];
    for (const input of bad) {
      await expect(inA1(() => knowledge.ingestDocument(input))).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });

  it("relação entre entidades de clientes diferentes é barrada (ref desconhecida e FK)", async () => {
    // Pelo serviço: a ref de A1 não existe para A2 → ValidationError limpo.
    await expect(
      inA2(() =>
        knowledge.ingestDocument({
          source: "x",
          title: "cross",
          text: "Tentativa de ligar ao PETR4 de outro cliente.",
          entities: [{ type: "instituicao", name: "BTG" }],
          relations: [
            { sourceRef: "ativo:PETR4", targetRef: "instituicao:BTG", type: "CUSTODIADO_EM" },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    // Abaixo do serviço: ids de entidades de A1 numa relação de A2 violam a FK composta.
    const [petr] = await migratorSql<{ id: string }>(
      `SELECT id FROM kg_entity WHERE type = 'ativo' AND name = 'PETR4'`,
      [],
      { tenantId: tenantA, clientId: clientA1 },
    );
    const [btg] = await migratorSql<{ id: string }>(
      `SELECT id FROM kg_entity WHERE type = 'instituicao' AND name = 'BTG'`,
      [],
      { tenantId: tenantA, clientId: clientA2 },
    );
    expect(petr?.id).toBeDefined();
    expect(btg?.id).toBeDefined();
    const err = await inA2(() =>
      db.tx((tx) =>
        repo.insertRelations(tx, [
          {
            sourceId: petr?.id ?? "",
            targetId: btg?.id ?? "",
            type: "CUSTODIADO_EM",
            chunkId: null,
          },
        ]),
      ),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(await count("kg_relation", tenantA, clientA2)).toBe(1); // só a CDB→BTG da reingestão
  });

  it("SET de hnsw.iterative_scan: aplicado (pgvector ≥ 0.8) ou contido no SAVEPOINT; a tx segue válida", async () => {
    const out = await inA1(() =>
      db.tx(async (tx) => {
        const applied = await repo.enableIterativeScan(tx);
        // a transação continua utilizável depois de um SET recusado
        const [row] = await tx.$queryRaw<{ v: string | null }[]>`
          SELECT current_setting('hnsw.iterative_scan', true) AS v`;
        const chunks = await repo.searchChunks(tx, {
          text: "PETR4",
          vector: new HashEmbeddings().embed("PETR4"),
          k: 6,
        });
        return { applied, setting: row?.v ?? null, chunks: chunks.length };
      }),
    );
    const [ver] = await migratorSql<{ v: string }>(
      `SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`,
    );
    const [major = 0, minor = 0] = (ver?.v ?? "0.0").split(".").map(Number);
    const supports = major > 0 || minor >= 8;
    expect(out.applied).toBe(supports);
    if (supports) expect(out.setting).toBe("relaxed_order");
    expect(out.chunks).toBeGreaterThan(0);
    // SET LOCAL não vaza para a próxima transação da mesma conexão
    const after = await inA1(() =>
      db.tx(
        async (tx) => tx.$queryRaw<{ v: string | null }[]>`
        SELECT current_setting('hnsw.iterative_scan', true) AS v`,
      ),
    );
    expect(after[0]?.v ?? null).not.toBe("relaxed_order");
  });

  it("busca completa roda várias vezes seguidas com o SAVEPOINT", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await inA1(() => knowledge.search("PETR4"));
      expect(res.chunks[0]?.content).toBe("Carteira: 500 ações PETR4 na XP");
    }
  });

  it("o KnowledgeModule monta com o ModelFactory real em modo mock", async () => {
    const t = await createTestApp({ imports: [KnowledgeModule], redisDb: REDIS_DB });
    try {
      const svc = t.app.get(KnowledgeService);
      const res = await inA1(() => svc.search("PETR4"));
      expect(res.chunks[0]?.title).toBe("Carteira XP");
    } finally {
      await t.close();
    }
  });
});
