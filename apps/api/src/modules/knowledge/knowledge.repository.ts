/**
 * SQL do conhecimento (kg_*), sempre dentro de uma `tx` do TenantPrismaService.
 *
 * - Só `$queryRaw`/`$executeRaw` em template (valores sempre como parâmetros); nada de SQL montado
 *   com strings. Vetores entram como texto `'[v1,...]'` montado aqui a partir de números finitos
 *   e convertidos no SQL (`::vector`).
 * - `tenant_id`/`client_id` gravados vêm de `current_setting('app.*')`, o mesmo contexto que o RLS
 *   (`tenant_client_strict`) usa para filtrar e checar: nada de id de tenant/cliente vindo de
 *   fora. Leituras não filtram por tenant/cliente à mão: o RLS faz isso, e sem cliente fixado
 *   não devolve nenhuma linha.
 */
import { Injectable } from "@nestjs/common";
import { ValidationError } from "../../core/errors/domain-errors.js";
import type { Prisma } from "../../generated/prisma/client.js";

export const EMBEDDING_DIMENSIONS = 1024;
/** Candidatos de cada ranker antes da fusão. */
export const RANKER_LIMIT = 8;
/** Constante do Reciprocal Rank Fusion: `score = Σ 1/(RRF_K + rank)`. */
export const RRF_K = 60;
export const NEIGHBOR_LIMIT = 20;
export const NEIGHBOR_HOPS = 2;

type Tx = Prisma.TransactionClient;

/** Literal de vetor do pgvector; só aceita a dimensão esperada e números finitos. */
export function toVectorLiteral(v: readonly number[]): string {
  if (v.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Embedding com ${v.length} dimensões; esperado ${EMBEDDING_DIMENSIONS}`);
  }
  return `[${v
    .map((x) => {
      if (typeof x !== "number" || !Number.isFinite(x)) throw new Error("Embedding não finito");
      return String(x);
    })
    .join(",")}]`;
}

/**
 * SQLSTATE do Postgres num erro do Prisma com o driver adapter do pg
 * (`PrismaClientKnownRequestError{ code: "P2010", meta.driverAdapterError.cause.originalCode }`)
 * ou do próprio pg (`DatabaseError{ code, severity }`). O `code` do Prisma (`P2010`) não conta.
 */
export function sqlState(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (e: unknown): string | undefined => {
    if (!e || typeof e !== "object" || seen.has(e)) return undefined;
    seen.add(e);
    const o = e as Record<string, unknown>;
    if (typeof o["originalCode"] === "string") return o["originalCode"];
    if (typeof o["code"] === "string" && typeof o["severity"] === "string") return o["code"];
    return walk(o["meta"]) ?? walk(o["driverAdapterError"]) ?? walk(o["cause"]);
  };
  return walk(err);
}

export interface ChunkRow {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  score: number;
}

export interface EntityRow {
  id: string;
  type: string;
  name: string;
  properties: Record<string, unknown>;
}

export interface NeighborRow {
  from: string;
  type: string;
  to: string;
}

export interface NewChunk {
  id: string;
  content: string;
  embedding: readonly number[];
}

export interface NewEntity {
  type: string;
  name: string;
  properties: Record<string, unknown>;
  embedding: readonly number[];
}

export interface NewRelation {
  sourceId: string;
  targetId: string;
  type: string;
  chunkId: string | null;
}

// Parâmetros desconhecidos sob prefixo reservado: 42704 (unrecognized configuration parameter) ou
// 42602 (invalid configuration parameter name), conforme a biblioteca já estiver carregada.
const UNKNOWN_SETTING = new Set(["42704", "42602"]);

@Injectable()
export class KnowledgeRepository {
  /**
   * `SET LOCAL hnsw.iterative_scan = relaxed_order` (pgvector ≥ 0.8: o HNSW continua varrendo
   * quando o RLS filtra candidatos). Versões antigas não conhecem a opção: o erro fica contido num
   * SAVEPOINT e a transação segue válida. Antes, carrega a biblioteca do pgvector, para que a
   * opção seja reconhecida (ou recusada) já aqui, e não vire um placeholder.
   * Devolve se a opção foi aplicada.
   */
  async enableIterativeScan(tx: Tx): Promise<boolean> {
    await tx.$queryRaw`SELECT ${"[0]"}::vector IS NOT NULL AS loaded`;
    await tx.$executeRaw`SAVEPOINT knowledge_iterative_scan`;
    try {
      await tx.$executeRaw`SET LOCAL hnsw.iterative_scan = relaxed_order`;
      await tx.$executeRaw`RELEASE SAVEPOINT knowledge_iterative_scan`;
      return true;
    } catch (err) {
      if (!UNKNOWN_SETTING.has(sqlState(err) ?? "")) throw err;
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT knowledge_iterative_scan`;
      await tx.$executeRaw`RELEASE SAVEPOINT knowledge_iterative_scan`;
      return false;
    }
  }

  /**
   * Top `RANKER_LIMIT` por distância de cosseno e top `RANKER_LIMIT` por `ts_rank`, fundidos por
   * RRF; devolve os `k` melhores com documento e título para citação.
   */
  async searchChunks(
    tx: Tx,
    q: { text: string; vector: readonly number[]; k: number },
  ): Promise<ChunkRow[]> {
    const vec = toVectorLiteral(q.vector);
    const rows = await tx.$queryRaw<
      { chunk_id: string; document_id: string; title: string; content: string; score: number }[]
    >`
      WITH vec AS (
        SELECT id, row_number() OVER (ORDER BY dist, id) AS rnk
        FROM (
          SELECT id, embedding <=> ${vec}::vector AS dist
          FROM kg_chunk
          WHERE embedding IS NOT NULL
          ORDER BY embedding <=> ${vec}::vector
          LIMIT ${RANKER_LIMIT}
        ) v
      ),
      fts AS (
        SELECT id, row_number() OVER (ORDER BY rank DESC, id) AS rnk
        FROM (
          SELECT c.id, ts_rank(c.tsv, query) AS rank
          FROM kg_chunk c, websearch_to_tsquery('portuguese', ${q.text}) AS query
          WHERE c.tsv @@ query
          ORDER BY rank DESC, c.id
          LIMIT ${RANKER_LIMIT}
        ) f
      ),
      fused AS (
        SELECT id, sum(1.0 / (${RRF_K} + rnk))::float8 AS score
        FROM (SELECT id, rnk FROM vec UNION ALL SELECT id, rnk FROM fts) u
        GROUP BY id
        ORDER BY score DESC, id
        LIMIT ${q.k}
      )
      SELECT c.id AS chunk_id, c.document_id, d.title, c.content, f.score
      FROM fused f
      JOIN kg_chunk c ON c.id = f.id
      JOIN kg_document d ON d.id = c.document_id
      ORDER BY f.score DESC, c.id`;
    return rows.map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      title: r.title,
      content: r.content,
      score: Number(r.score),
    }));
  }

  /** Entidades mencionadas nos chunks (via kg_mention). */
  async entitiesForChunks(tx: Tx, chunkIds: readonly string[]): Promise<EntityRow[]> {
    if (chunkIds.length === 0) return [];
    return tx.$queryRaw<EntityRow[]>`
      SELECT DISTINCT e.id, e.type, e.name, e.properties
      FROM kg_mention m
      JOIN kg_entity e ON e.id = m.entity_id
      WHERE m.chunk_id = ANY(${[...chunkIds]}::uuid[])
      ORDER BY e.type, e.name`;
  }

  /**
   * Relações a até `NEIGHBOR_HOPS` saltos das entidades (o grafo é percorrido nos dois sentidos;
   * a relação sai com o sentido gravado), as mais próximas primeiro, no máximo `NEIGHBOR_LIMIT`.
   */
  async neighbors(tx: Tx, entityIds: readonly string[]): Promise<NeighborRow[]> {
    if (entityIds.length === 0) return [];
    return tx.$queryRaw<NeighborRow[]>`
      WITH RECURSIVE walk(entity_id, depth) AS (
        SELECT DISTINCT unnest(${[...entityIds]}::uuid[]), 0
        UNION
        SELECT CASE WHEN r.source_id = w.entity_id THEN r.target_id ELSE r.source_id END,
               w.depth + 1
        FROM walk w
        JOIN kg_relation r ON r.source_id = w.entity_id OR r.target_id = w.entity_id
        WHERE w.depth < ${NEIGHBOR_HOPS} - 1
      ),
      nodes AS (
        SELECT entity_id, min(depth) AS depth FROM walk GROUP BY entity_id
      ),
      edges AS (
        SELECT r.source_id, r.type, r.target_id, min(n.depth) + 1 AS hop
        FROM kg_relation r
        JOIN nodes n ON n.entity_id = r.source_id OR n.entity_id = r.target_id
        GROUP BY r.source_id, r.type, r.target_id
      )
      SELECT s.type || ':' || s.name AS "from", ed.type, t.type || ':' || t.name AS "to"
      FROM edges ed
      JOIN kg_entity s ON s.id = ed.source_id
      JOIN kg_entity t ON t.id = ed.target_id
      ORDER BY ed.hop, 1, 2, 3
      LIMIT ${NEIGHBOR_LIMIT}`;
  }

  /**
   * Serializa ingestões do mesmo `(source, title)` do cliente (lock até o fim da transação), para
   * duas ingestões concorrentes não criarem dois documentos.
   */
  async lockDocument(tx: Tx, source: string, title: string): Promise<void> {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
        'kg_document',
        current_setting('app.tenant_id', true),
        current_setting('app.client_id', true),
        ${source}::text,
        ${title}::text
      )::text, 0)) IS NULL AS locked`;
  }

  async findDocument(tx: Tx, source: string, title: string): Promise<string | undefined> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM kg_document
      WHERE source = ${source} AND title = ${title}
      ORDER BY created_at, id
      LIMIT 1
      FOR UPDATE`;
    return rows[0]?.id;
  }

  async insertDocument(tx: Tx, source: string, title: string): Promise<string> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO kg_document (tenant_id, client_id, source, title)
      VALUES (
        current_setting('app.tenant_id')::uuid,
        current_setting('app.client_id')::uuid,
        ${source}, ${title}
      )
      RETURNING id`;
    const id = rows[0]?.id;
    if (!id) throw new Error("INSERT INTO kg_document não devolveu id");
    return id;
  }

  /**
   * Apaga o conteúdo derivado do documento: relações ligadas aos seus chunks (a FK é ON DELETE
   * SET NULL e as deixaria soltas), depois os chunks (as menções caem em cascata).
   */
  async clearDocument(tx: Tx, documentId: string): Promise<void> {
    await tx.$executeRaw`
      DELETE FROM kg_relation
      WHERE chunk_id IN (SELECT id FROM kg_chunk WHERE document_id = ${documentId}::uuid)`;
    await tx.$executeRaw`DELETE FROM kg_chunk WHERE document_id = ${documentId}::uuid`;
  }

  async insertChunks(tx: Tx, documentId: string, chunks: readonly NewChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const ids = chunks.map((c) => c.id);
    const contents = chunks.map((c) => c.content);
    const vectors = chunks.map((c) => toVectorLiteral(c.embedding));
    await tx.$executeRaw`
      INSERT INTO kg_chunk (id, tenant_id, client_id, document_id, content, embedding)
      SELECT t.id, current_setting('app.tenant_id')::uuid, current_setting('app.client_id')::uuid,
             ${documentId}::uuid, t.content, t.embedding::vector
      FROM unnest(${ids}::uuid[], ${contents}::text[], ${vectors}::text[])
        AS t(id, content, embedding)`;
  }

  /**
   * Upsert por `(type, name)`: propriedades novas são mescladas às existentes (`||`) e o
   * embedding é atualizado. A entrada não pode repetir `(type, name)`.
   */
  async upsertEntities(tx: Tx, entities: readonly NewEntity[]): Promise<EntityRow[]> {
    if (entities.length === 0) return [];
    const types = entities.map((e) => e.type);
    const names = entities.map((e) => e.name);
    const props = entities.map((e) => JSON.stringify(e.properties));
    const vectors = entities.map((e) => toVectorLiteral(e.embedding));
    return tx.$queryRaw<EntityRow[]>`
      INSERT INTO kg_entity (tenant_id, client_id, type, name, properties, embedding)
      SELECT current_setting('app.tenant_id')::uuid, current_setting('app.client_id')::uuid,
             t.type, t.name, t.properties::jsonb, t.embedding::vector
      FROM unnest(${types}::text[], ${names}::text[], ${props}::text[], ${vectors}::text[])
        AS t(type, name, properties, embedding)
      ON CONFLICT (tenant_id, client_id, type, name) DO UPDATE
        SET properties = kg_entity.properties || EXCLUDED.properties,
            embedding = EXCLUDED.embedding
      RETURNING id, type, name, properties`;
  }

  /** Entidades já existentes (do cliente, pelo RLS) com estes `(type, name)`. */
  async findEntities(
    tx: Tx,
    keys: readonly { type: string; name: string }[],
  ): Promise<EntityRow[]> {
    if (keys.length === 0) return [];
    const types = keys.map((k) => k.type);
    const names = keys.map((k) => k.name);
    return tx.$queryRaw<EntityRow[]>`
      SELECT e.id, e.type, e.name, e.properties
      FROM kg_entity e
      JOIN unnest(${types}::text[], ${names}::text[]) AS k(type, name)
        ON e.type = k.type AND e.name = k.name`;
  }

  async insertMentions(
    tx: Tx,
    mentions: readonly { chunkId: string; entityId: string }[],
  ): Promise<void> {
    if (mentions.length === 0) return;
    const chunkIds = mentions.map((m) => m.chunkId);
    const entityIds = mentions.map((m) => m.entityId);
    await this.mapFkViolation(
      tx.$executeRaw`
        INSERT INTO kg_mention (tenant_id, client_id, chunk_id, entity_id)
        SELECT current_setting('app.tenant_id')::uuid, current_setting('app.client_id')::uuid,
               t.chunk_id, t.entity_id
        FROM unnest(${chunkIds}::uuid[], ${entityIds}::uuid[]) AS t(chunk_id, entity_id)
        ON CONFLICT (chunk_id, entity_id) DO NOTHING`,
      "Menção a chunk ou entidade de outro cliente",
    );
  }

  /**
   * Insere relações. As FKs compostas `(tenant_id, client_id, source_id|target_id)` impedem ligar
   * entidades de outro cliente: a violação vira ValidationError.
   */
  async insertRelations(tx: Tx, relations: readonly NewRelation[]): Promise<void> {
    if (relations.length === 0) return;
    const sources = relations.map((r) => r.sourceId);
    const targets = relations.map((r) => r.targetId);
    const types = relations.map((r) => r.type);
    const chunks = relations.map((r) => r.chunkId);
    await this.mapFkViolation(
      tx.$executeRaw`
        INSERT INTO kg_relation (tenant_id, client_id, source_id, target_id, type, chunk_id)
        SELECT current_setting('app.tenant_id')::uuid, current_setting('app.client_id')::uuid,
               t.source_id, t.target_id, t.type, t.chunk_id
        FROM unnest(${sources}::uuid[], ${targets}::uuid[], ${types}::text[], ${chunks}::uuid[])
          AS t(source_id, target_id, type, chunk_id)`,
      "Relação entre entidades que não são deste cliente",
    );
  }

  private async mapFkViolation<T>(query: Promise<T>, message: string): Promise<T> {
    try {
      return await query;
    } catch (err) {
      if (sqlState(err) === "23503") throw new ValidationError(message);
      throw err;
    }
  }
}
