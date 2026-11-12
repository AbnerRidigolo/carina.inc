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
import { IngestionRepository } from "./ingestion.repository.js";
import type { Source } from "./provider.js";

export const MAX_BATCH_ITEMS = 1000;
export const DEFAULT_TRANSACTIONS_LIMIT = 100;
export const MAX_TRANSACTIONS_LIMIT = 1000;

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

  /** Cliente inexistente (ou de outro tenant) → NotFoundError. */
  async listPositions(clientExternalId: string): Promise<NormalizedPosition[]> {
    const client = await this.clients.resolve(clientExternalId);
    return TenantContext.withClient(client.id, () => this.repo.listPositions(client.id));
  }

  /** Mais recentes primeiro. Cliente inexistente (ou de outro tenant) → NotFoundError. */
  async listTransactions(
    clientExternalId: string,
    opts: ListTransactionsOptions = {},
  ): Promise<NormalizedTransaction[]> {
    const limit = opts.limit ?? DEFAULT_TRANSACTIONS_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRANSACTIONS_LIMIT) {
      throw new ValidationError(`limit precisa ser um inteiro entre 1 e ${MAX_TRANSACTIONS_LIMIT}`);
    }
    assertDay("from", opts.from);
    assertDay("to", opts.to);
    if (opts.from !== undefined && opts.to !== undefined && opts.from > opts.to) {
      throw new ValidationError("from não pode ser depois de to");
    }
    const client = await this.clients.resolve(clientExternalId);
    return TenantContext.withClient(client.id, () =>
      this.repo.listTransactions(client.id, {
        limit,
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
