/**
 * Ingestão de posições e transações do cliente final (fonte `api`, e a base para `import` e
 * `synthetic`).
 *
 * Cada lote aceito: (1) resolve ou cria o cliente do tenant; (2) deduplica por `externalId` (o
 * último vence); (3) faz o upsert e registra a cobrança `data_ingestion` na MESMA transação, com o
 * contexto do tenant e do cliente fixado (RLS): lote gravado ⇔ lote cobrado; (4) só depois do
 * COMMIT publica `data.ingested` em `jobs`, em melhor esforço: se a publicação falhar, o erro é
 * logado e o lote continua aceito (o worker de Sync pode refazer a sincronização completa).
 */
import { randomUUID } from "node:crypto";
import type { NormalizedPosition, NormalizedTransaction, WorkType } from "@carina/shared";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { TenantContext } from "../../core/context/tenant-context.js";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import { ValidationError } from "../../core/errors/domain-errors.js";
import { StreamsService } from "../../core/redis/streams.service.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { BillingService } from "../billing/billing.service.js";
import { ClientsService, type ClientRef } from "../tenancy/clients.service.js";
import {
  IngestionRepository,
  type Page,
  type PositionCursor,
  type TransactionCursor,
} from "./ingestion.repository.js";
import { SOURCES, type Source } from "./provider.js";

export const MAX_BATCH_ITEMS = 1000;
export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_SIZE = 1000;

/**
 * Forma de OBJETO no 1º argumento (o Logger do Nest com nestjs-pino faz `Object.assign` dele no
 * registro do pino): `err` fica no topo e o serializador guarda tipo, mensagem e stack.
 */
export interface IngestionLogFields {
  msg: string;
  err?: unknown;
  [field: string]: unknown;
}

export interface IngestionLogger {
  error(fields: IngestionLogFields): void;
}

export const INGESTION_LOGGER = Symbol("INGESTION_LOGGER");

export interface IngestResult {
  /** Linhas gravadas (inseridas ou atualizadas), já sem os `externalId` repetidos do lote. */
  upserted: number;
  usage: { workType: WorkType; priceBrl: string };
}

export interface ListTransactionsOptions {
  /** `YYYY-MM-DD`, inclusivo. */
  from?: string;
  to?: string;
  /** 1..1000; padrão 100. */
  limit?: number;
}

export interface ListPositionsOptions {
  /** 1..1000; padrão 100. */
  limit?: number;
  /** `nextCursor` da página anterior. */
  after?: string;
}

export interface PositionsPage {
  positions: NormalizedPosition[];
  /** Passe como `after` para a próxima página; `null` na última. */
  nextCursor: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(field: string, value: string): void {
  if (!UUID_RE.test(value)) throw new ValidationError(`${field} precisa ser um uuid`);
}

function assertPageSize(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new ValidationError(`${field} precisa ser um inteiro entre 1 e ${MAX_PAGE_SIZE}`);
  }
}

function assertRange(from: string | undefined, to: string | undefined): void {
  assertDay("from", from);
  assertDay("to", to);
  if (from !== undefined && to !== undefined && from > to) {
    throw new ValidationError("from não pode ser depois de to");
  }
}

const EXTERNAL_ID_RE = /^[^\p{C}]{1,128}$/u;

/** Cursor opaco da paginação de posições: base64url de `[externalId, source]`. */
function encodeCursor(c: PositionCursor): string {
  return Buffer.from(JSON.stringify([c.externalId, c.source]), "utf8").toString("base64url");
}

function decodeCursor(raw: string): PositionCursor {
  const invalid = () => new ValidationError("after não é um cursor válido");
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(raw)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string"
  ) {
    throw invalid();
  }
  const [externalId, source] = parsed as [string, string];
  // Mesma regra do `externalId` dos contratos e do cliente (1..128, sem \p{C}: NUL, controle,
  // formatação, surrogate solto) e `source` só do enum: o cursor é entrada de quem chama e chega ao
  // SQL como parâmetro; o banco recusa NUL em texto (22021), o que viraria 500.
  if (!EXTERNAL_ID_RE.test(externalId) || !(SOURCES as readonly string[]).includes(source)) {
    throw invalid();
  }
  return { externalId, source };
}

/**
 * Lê página a página por keyset. Cada página fixa o cliente com `withClient` sobre o contexto de
 * tenant que o consumidor tem na hora do `next()`; uma página vazia termina a iteração.
 */
async function* paginate<T, C>(
  clientId: string,
  fetchPage: (after: C | undefined) => Promise<Page<T, C>>,
): AsyncGenerator<T[]> {
  let after: C | undefined;
  for (;;) {
    const page = await TenantContext.withClient(clientId, () => fetchPage(after));
    if (page.items.length > 0) yield page.items;
    if (!page.hasMore || page.last === undefined) return;
    after = page.last;
  }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDay(field: string, value: string | undefined): void {
  if (value === undefined) return;
  // Formato E data real (2026-02-30 não passa): o round-trip por Date precisa devolver o mesmo dia.
  const valid =
    DAY_RE.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
  if (!valid) throw new ValidationError(`${field} precisa ser uma data YYYY-MM-DD válida`);
}

/** Último item de cada `externalId` vence; ordena por `externalId` (ordem de bloqueio estável). */
export function dedupeByExternalId<T extends { externalId: string }>(items: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.externalId, item);
  return [...byId.values()].sort((a, b) =>
    a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0,
  );
}

@Injectable()
export class IngestionService {
  constructor(
    @Inject(ClientsService) private readonly clients: ClientsService,
    @Inject(TenantPrismaService) private readonly db: TenantPrismaService,
    @Inject(IngestionRepository) private readonly repo: IngestionRepository,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(StreamsService) private readonly streams: StreamsService,
    @Inject(INGESTION_LOGGER) private readonly logger: IngestionLogger,
  ) {}

  /** Cria o cliente se não existir. */
  upsertPositions(
    clientExternalId: string,
    source: Source,
    items: readonly NormalizedPosition[],
  ): Promise<IngestResult> {
    return this.ingest(clientExternalId, source, items, (tx, rows) =>
      this.repo.upsertPositions(tx, source, rows),
    );
  }

  /** Cria o cliente se não existir. */
  upsertTransactions(
    clientExternalId: string,
    source: Source,
    items: readonly NormalizedTransaction[],
  ): Promise<IngestResult> {
    return this.ingest(clientExternalId, source, items, (tx, rows) =>
      this.repo.upsertTransactions(tx, source, rows),
    );
  }

  /**
   * Uma página de posições por `externalId` (a ordem é por `(externalId, source)`), para a camada
   * HTTP. `after` é o `nextCursor` da página anterior. Cliente inexistente (ou de outro tenant) →
   * NotFoundError.
   */
  async listPositions(
    clientExternalId: string,
    opts: ListPositionsOptions = {},
  ): Promise<PositionsPage> {
    const limit = opts.limit ?? DEFAULT_PAGE_LIMIT;
    assertPageSize("limit", limit);
    const after = opts.after === undefined ? undefined : decodeCursor(opts.after);
    const client = await this.clients.resolve(clientExternalId);
    const page = await TenantContext.withClient(client.id, () =>
      this.repo.positionsPage(client.id, { take: limit, ...(after ? { after } : {}) }),
    );
    return {
      positions: page.items,
      nextCursor: page.hasMore && page.last ? encodeCursor(page.last) : null,
    };
  }

  /** Mais recentes primeiro. Cliente inexistente (ou de outro tenant) → NotFoundError. */
  async listTransactions(
    clientExternalId: string,
    opts: ListTransactionsOptions = {},
  ): Promise<NormalizedTransaction[]> {
    const limit = opts.limit ?? DEFAULT_PAGE_LIMIT;
    assertPageSize("limit", limit);
    assertRange(opts.from, opts.to);
    const client = await this.clients.resolve(clientExternalId);
    const page = await TenantContext.withClient(client.id, () =>
      this.repo.transactionsPage(client.id, {
        take: limit,
        ...(opts.from !== undefined ? { from: opts.from } : {}),
        ...(opts.to !== undefined ? { to: opts.to } : {}),
      }),
    );
    return page.items;
  }

  /**
   * Todas as posições do cliente (id INTERNO, uuid) em páginas por keyset, sem teto total: para
   * consumidores em processo (worker de Sync). Roda sob o TenantContext do chamador (o tenant já
   * fixado) e fixa o cliente por dentro, então o RLS vale: um `clientId` que não é do tenant atual
   * (ou não existe) não devolve nenhuma página (não lança NotFound). Sem TenantContext →
   * UnauthenticatedError na primeira leitura. `clientId` que não é uuid ou `pageSize` fora de
   * 1..1000 → ValidationError, lançado já na chamada.
   */
  iteratePositions(
    clientId: string,
    opts: { pageSize?: number } = {},
  ): AsyncIterable<NormalizedPosition[]> {
    assertUuid("clientId", clientId);
    const size = opts.pageSize ?? MAX_PAGE_SIZE;
    assertPageSize("pageSize", size);
    return paginate<NormalizedPosition, PositionCursor>(clientId, (after) =>
      this.repo.positionsPage(clientId, { take: size, ...(after ? { after } : {}) }),
    );
  }

  /**
   * Todas as transações do cliente (id interno), mais recentes primeiro (`date desc, externalId,
   * source`), em páginas por keyset, sem teto total. Mesmas regras de contexto, RLS e validação de
   * `iteratePositions`; `from`/`to` (`YYYY-MM-DD`, inclusivos) filtram.
   */
  iterateTransactions(
    clientId: string,
    opts: { pageSize?: number; from?: string; to?: string } = {},
  ): AsyncIterable<NormalizedTransaction[]> {
    assertUuid("clientId", clientId);
    const size = opts.pageSize ?? MAX_PAGE_SIZE;
    assertPageSize("pageSize", size);
    assertRange(opts.from, opts.to);
    return paginate<NormalizedTransaction, TransactionCursor>(clientId, (after) =>
      this.repo.transactionsPage(clientId, {
        take: size,
        ...(after ? { after } : {}),
        ...(opts.from !== undefined ? { from: opts.from } : {}),
        ...(opts.to !== undefined ? { to: opts.to } : {}),
      }),
    );
  }

  private async ingest<T extends { externalId: string }>(
    clientExternalId: string,
    source: Source,
    items: readonly T[],
    upsert: (tx: Prisma.TransactionClient, rows: T[]) => Promise<number>,
  ): Promise<IngestResult> {
    if (items.length === 0 || items.length > MAX_BATCH_ITEMS) {
      throw new ValidationError(`O lote precisa ter de 1 a ${MAX_BATCH_ITEMS} itens`);
    }
    const { tenantId } = TenantContext.current();
    const client = await this.clients.resolve(clientExternalId, { create: true });
    const rows = dedupeByExternalId(items);

    const started = performance.now();
    const result = await TenantContext.withClient(client.id, () =>
      this.db.tx(async (tx) => {
        const upserted = await upsert(tx, rows);
        const usage = await this.billing.record({
          tx,
          clientId: client.id,
          workType: "data_ingestion",
          agents: [],
          durationMs: Math.round(performance.now() - started),
        });
        return {
          upserted,
          usage: { workType: "data_ingestion" as const, priceBrl: usage.priceBrl.toFixed(2) },
        };
      }),
    );

    await this.notify(tenantId, client, source);
    return result;
  }

  /** Depois do COMMIT e em melhor esforço: dado e cobrança já estão confirmados. */
  private async notify(tenantId: string, client: ClientRef, source: Source): Promise<void> {
    try {
      await this.streams.publish("jobs", {
        eventId: randomUUID(),
        type: "data.ingested",
        tenantId,
        clientId: client.id,
        source,
      });
    } catch (err) {
      this.logger.error({
        msg: "Falha ao publicar data.ingested; o lote foi gravado e cobrado",
        err,
        tenantId,
        clientId: client.id,
        source,
      });
    }
  }
}

/** Provider do logger do serviço (substituível em testes com `overrideProvider`). */
export const ingestionLoggerProvider = {
  provide: INGESTION_LOGGER,
  useFactory: (): IngestionLogger => new Logger(IngestionService.name),
};
