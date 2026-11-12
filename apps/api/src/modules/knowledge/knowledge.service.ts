/**
 * Conhecimento do cliente final: ingestão de documentos (chunks, entidades, relações, menções e
 * embeddings) e busca híbrida (vetor + full-text fundidos por RRF, entidades citadas e vizinhança
 * de até 2 saltos no grafo), com citação da fonte.
 *
 * Isolamento: todas as tabelas kg_* exigem tenant E cliente no contexto (RLS
 * `tenant_client_strict`). Sem cliente fixado (`TenantContext.withClient`), `search` e
 * `ingestDocument` falham fechado com ValidationError, antes de qualquer SQL ou embedding; sem
 * contexto nenhum, UnauthenticatedError.
 */
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { TenantContext } from "../../core/context/tenant-context.js";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import { ValidationError } from "../../core/errors/domain-errors.js";
import { ModelFactory } from "../llm/model-factory.js";
import { chunkText } from "./chunker.js";
import { KnowledgeRepository, type EntityRow, type NewRelation } from "./knowledge.repository.js";
import { citesName, compareEntityKeys, foldText } from "./mention-match.js";

export const DEFAULT_SEARCH_K = 6;
export const MAX_SEARCH_K = 50;
export const MAX_QUERY_CHARS = 2000;

export interface EntityInput {
  type: string;
  name: string;
  properties?: object;
}

export interface RelationInput {
  sourceRef: string;
  targetRef: string;
  type: string;
}

export interface IngestInput {
  source: string;
  title: string;
  text: string;
  entities?: EntityInput[];
  relations?: RelationInput[];
  /** Refs `"<type>:<name>"` citadas no documento. Sem isto, as `entities` do documento. */
  mentions?: string[];
}

export interface IngestResult {
  documentId: string;
  chunkIds: string[];
}

export interface SearchChunk {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  score: number;
}

export interface SearchResult {
  chunks: SearchChunk[];
  entities: { type: string; name: string; properties: Record<string, unknown> }[];
  neighbors: { from: string; type: string; to: string }[];
}

interface EntityKey {
  type: string;
  name: string;
}

export const entityRef = (e: EntityKey): string => `${e.type}:${e.name}`;

/** `"<type>:<name>"`, separado no primeiro `:` (o tipo não tem `:`; o nome pode ter). */
export function parseRef(ref: unknown): EntityKey {
  if (typeof ref !== "string") throw new ValidationError("ref de entidade precisa ser texto");
  const i = ref.indexOf(":");
  const type = i > 0 ? ref.slice(0, i) : "";
  const name = i > 0 ? ref.slice(i + 1) : "";
  if (!type.trim() || !name.trim()) {
    throw new ValidationError(`ref de entidade inválida (use "<tipo>:<nome>"): ${ref}`);
  }
  return { type, name };
}

function requireText(field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${field} precisa ser um texto não vazio`);
  }
  return value;
}

function plainObject(field: string, value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${field} precisa ser um objeto`);
  }
  return value as Record<string, unknown>;
}

@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(TenantPrismaService) private readonly db: TenantPrismaService,
    @Inject(KnowledgeRepository) private readonly repo: KnowledgeRepository,
    @Inject(ModelFactory) private readonly models: ModelFactory,
  ) {}

  /** Falha fechado: o conhecimento é sempre de um cliente final. */
  private requireClient(): void {
    if (!TenantContext.current().clientId) {
      throw new ValidationError("Conhecimento exige um cliente final fixado no contexto");
    }
  }

  async ingestDocument(input: IngestInput): Promise<IngestResult> {
    this.requireClient();
    const source = requireText("source", input.source);
    const title = requireText("title", input.title);
    const text = requireText("text", input.text);

    // Entidades: valida e junta repetidas por (type, name), mesclando propriedades.
    const entities = new Map<
      string,
      { type: string; name: string; properties: Record<string, unknown> }
    >();
    for (const e of input.entities ?? []) {
      const type = requireText("entities[].type", e.type);
      const name = requireText("entities[].name", e.name);
      if (type.includes(":")) throw new ValidationError("entities[].type não pode conter ':'");
      const properties = plainObject("entities[].properties", e.properties);
      const ref = entityRef({ type, name });
      const prev = entities.get(ref);
      entities.set(ref, { type, name, properties: { ...prev?.properties, ...properties } });
    }

    const relations = (input.relations ?? []).map((r) => ({
      source: parseRef(r.sourceRef),
      target: parseRef(r.targetRef),
      type: requireText("relations[].type", r.type),
    }));
    const mentionRefs = input.mentions ?? [...entities.keys()];
    const mentions = mentionRefs.map(parseRef);

    const chunks = chunkText(text);
    if (chunks.length === 0) throw new ValidationError("text sem conteúdo");

    // Embeddings num único lote, fora da transação (não segura conexão esperando o provedor).
    // Entidades em ordem canônica (type, name) por ponto de código: duas ingestões concorrentes do
    // mesmo cliente bloqueiam as linhas de kg_entity sempre na mesma ordem (sem deadlock 40P01);
    // o INSERT do repositório repete a ordem com COLLATE "C".
    const entityList = [...entities.values()].sort(compareEntityKeys);
    const vectors = await this.models
      .embeddings()
      .embedDocuments([...chunks, ...entityList.map((e) => `${e.type} ${e.name}`)]);
    if (vectors.length !== chunks.length + entityList.length) {
      throw new Error("Lote de embeddings incompleto");
    }
    const newChunks = chunks.map((content, i) => ({
      id: randomUUID(),
      content,
      embedding: vectors[i] ?? [],
    }));
    const newEntities = entityList.map((e, i) => ({
      ...e,
      embedding: vectors[chunks.length + i] ?? [],
    }));

    return this.db.tx(async (tx) => {
      await this.repo.lockDocument(tx, source, title);
      let documentId = await this.repo.findDocument(tx, source, title);
      if (documentId) await this.repo.clearDocument(tx, documentId);
      else documentId = await this.repo.insertDocument(tx, source, title);

      await this.repo.insertChunks(tx, documentId, newChunks);

      const byRef = new Map<string, EntityRow>();
      for (const row of await this.repo.upsertEntities(tx, newEntities)) {
        byRef.set(entityRef(row), row);
      }
      const missing = new Map<string, EntityKey>();
      for (const key of [...mentions, ...relations.flatMap((r) => [r.source, r.target])]) {
        const ref = entityRef(key);
        if (!byRef.has(ref)) missing.set(ref, key);
      }
      for (const row of await this.repo.findEntities(tx, [...missing.values()])) {
        byRef.set(entityRef(row), row);
      }
      const resolve = (key: EntityKey): EntityRow => {
        const row = byRef.get(entityRef(key));
        if (!row) throw new ValidationError(`Entidade desconhecida: ${entityRef(key)}`);
        return row;
      };

      // Menções: nos chunks que citam o nome como palavra inteira; se nenhum cita, só no primeiro
      // chunk (o documento menciona a entidade, mas sem espalhá-la por todos os chunks).
      const mentionRows = new Map<string, { chunkId: string; entityId: string }>();
      const firstChunk = newChunks.slice(0, 1);
      for (const key of mentions) {
        const entity = resolve(key);
        const hits = this.chunksCiting(newChunks, [entity.name]);
        for (const c of hits.length > 0 ? hits : firstChunk) {
          mentionRows.set(`${c.id}|${entity.id}`, { chunkId: c.id, entityId: entity.id });
        }
      }
      await this.repo.insertMentions(tx, [...mentionRows.values()]);

      // Relações: presas ao chunk que cita as duas pontas (ou uma, ou o primeiro), para que
      // reingerir o documento as substitua junto com os chunks.
      const relationRows = new Map<string, NewRelation>();
      for (const r of relations) {
        const s = resolve(r.source);
        const t = resolve(r.target);
        const chunk =
          this.chunksCiting(newChunks, [s.name, t.name])[0] ??
          this.chunksCiting(newChunks, [s.name])[0] ??
          this.chunksCiting(newChunks, [t.name])[0] ??
          newChunks[0];
        relationRows.set(`${s.id}|${r.type}|${t.id}`, {
          sourceId: s.id,
          targetId: t.id,
          type: r.type,
          chunkId: chunk?.id ?? null,
        });
      }
      await this.repo.insertRelations(tx, [...relationRows.values()]);

      return { documentId, chunkIds: newChunks.map((c) => c.id) };
    });
  }

  async search(query: string, opts: { k?: number } = {}): Promise<SearchResult> {
    this.requireClient();
    const k = opts.k ?? DEFAULT_SEARCH_K;
    if (!Number.isInteger(k) || k < 1 || k > MAX_SEARCH_K) {
      throw new ValidationError(`k precisa ser um inteiro entre 1 e ${MAX_SEARCH_K}`);
    }
    if (typeof query !== "string") throw new ValidationError("query precisa ser texto");
    const text = query.trim();
    if (!text) return { chunks: [], entities: [], neighbors: [] };
    if (text.length > MAX_QUERY_CHARS) {
      throw new ValidationError(`query com mais de ${MAX_QUERY_CHARS} caracteres`);
    }

    const vector = await this.models.embeddings().embedQuery(text);
    return this.db.tx(async (tx) => {
      await this.repo.enableIterativeScan(tx);
      const chunks = await this.repo.searchChunks(tx, { text, vector, k });
      const entities = await this.repo.entitiesForChunks(
        tx,
        chunks.map((c) => c.chunkId),
      );
      const neighbors = await this.repo.neighbors(
        tx,
        entities.map((e) => e.id),
      );
      return {
        chunks,
        entities: entities.map(({ type, name, properties }) => ({ type, name, properties })),
        neighbors: neighbors.map(({ from, type, to }) => ({ from, type, to })),
      };
    });
  }

  /** Chunks que citam todos os nomes como palavras inteiras (ver `citesName`). */
  private chunksCiting<C extends { content: string }>(chunks: C[], names: string[]): C[] {
    const needles = names.map(foldText);
    return chunks.filter((c) => {
      const hay = foldText(c.content);
      return needles.every((n) => citesName(hay, n));
    });
  }
}
