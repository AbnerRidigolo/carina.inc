/**
 * Worker de Sync (spec §6.4): transforma as posições e transações do cliente final em documentos
 * do conhecimento (`source: "sync"`): "Carteira consolidada" e "Fluxo de caixa 12 meses", com
 * entidades, relações e menções. Sem LLM: o texto é determinístico (ver sync-documents.ts).
 *
 * - Consumo: stream `jobs`, grupo `sync`. Só `data.ingested` dispara o Sync; os demais tipos são
 *   confirmados (ACK) sem efeito (outros consumidores de `jobs` usam grupos próprios).
 * - Contexto: o `tenantId` do evento vira o TenantContext (`run`) e o cliente é fixado por
 *   `withClient` só para as escritas no conhecimento; as leituras usam os iteradores do
 *   IngestionService, que fixam o cliente por dentro. Ids que não são uuid, ou cliente que não
 *   existe no tenant, são registrados (warn) e confirmados: não há o que tentar de novo. Qualquer
 *   outro erro é registrado (error) e relançado, e o StreamsService refaz a entrega (DLQ depois
 *   de 5 entregas).
 * - Idempotente: os documentos são reingeridos por `(source, title)` e o texto é função só dos
 *   dados (nada de relógio), então dois Syncs seguidos geram o mesmo conteúdo.
 * - Memória: leitura em páginas (keyset, até 1.000 linhas) agregadas em streaming; nenhuma lista
 *   completa de posições ou transações fica em memória.
 * - Ciclo de vida: liga em `onApplicationBootstrap` só com WORKERS_ENABLED !== "false"; para em
 *   `onModuleDestroy` (antes do RedisModule global fechar a conexão compartilhada), abortando o
 *   consumo (o que desconecta a conexão bloqueada do XREADGROUP) e esperando o loop terminar.
 */
import { hostname } from "node:os";
import type { StreamEvent } from "@carina/shared";
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ENV } from "../../core/config/config.module.js";
import type { Env } from "../../core/config/env.js";
import { TenantContext } from "../../core/context/tenant-context.js";
import { NotFoundError, ValidationError } from "../../core/errors/domain-errors.js";
import { StreamsService } from "../../core/redis/streams.service.js";
import { KnowledgeService } from "../knowledge/knowledge.service.js";
import { IngestionService } from "./ingestion.service.js";
import { CashFlowAggregator, PortfolioAggregator, type SyncDocument } from "./sync-documents.js";

export const SYNC_SOURCE = "sync";
export const SYNC_STREAM = "jobs";
export const SYNC_GROUP = "sync";
const RESTART_DELAY_MS = 1000;

/**
 * Forma de OBJETO no 1º argumento (o Logger do Nest com nestjs-pino faz `Object.assign` dele no
 * registro do pino): `err` fica no topo e o serializador guarda tipo, mensagem e stack. Nunca
 * colocar texto de documento, descrições ou valores aqui.
 */
export interface SyncLogFields {
  msg: string;
  err?: unknown;
  [field: string]: unknown;
}

export interface SyncLogger {
  warn(fields: SyncLogFields): void;
  error(fields: SyncLogFields): void;
}

export const SYNC_LOGGER = Symbol("SYNC_LOGGER");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(field: string, value: string): void {
  if (!UUID_RE.test(value)) throw new ValidationError(`${field} precisa ser um uuid`);
}

/** Id vindo do evento, só para log: cortado (o schema do stream aceita qualquer texto). */
const logId = (value: string) => value.slice(0, 64);

@Injectable()
export class SyncWorker
  implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown
{
  private abort: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(ENV) private readonly env: Pick<Env, "WORKERS_ENABLED">,
    @Inject(StreamsService) private readonly streams: StreamsService,
    @Inject(IngestionService) private readonly ingestion: IngestionService,
    @Inject(KnowledgeService) private readonly knowledge: KnowledgeService,
    @Inject(SYNC_LOGGER) private readonly logger: SyncLogger,
  ) {}

  /** O consumo do stream está ligado. */
  get running(): boolean {
    return this.loop !== undefined;
  }

  onApplicationBootstrap(): void {
    if (this.env.WORKERS_ENABLED === "false") return;
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /** Liga o consumo (idempotente). */
  start(): void {
    if (this.loop) return;
    const abort = new AbortController();
    this.abort = abort;
    this.loop = this.consumeUntilAborted(abort.signal);
  }

  /** Para o consumo e espera o loop terminar (idempotente). */
  async stop(): Promise<void> {
    const loop = this.loop;
    if (!loop) return;
    this.abort?.abort();
    await loop;
    this.loop = undefined;
    this.abort = undefined;
  }

  /**
   * Gera (ou regera) os documentos do Sync do cliente (id INTERNO) no tenant. Devolve quantos
   * documentos foram escritos (um tipo de dado sem nenhuma linha não gera documento).
   * Ids que não são uuid → ValidationError; cliente que não é do tenant → NotFoundError.
   */
  async syncClient(tenantId: string, clientId: string): Promise<{ documents: number }> {
    assertUuid("tenantId", tenantId);
    assertUuid("clientId", clientId);
    return TenantContext.run({ tenantId }, async () => {
      if (!(await this.ingestion.clientExists(clientId))) {
        throw new NotFoundError("Cliente não encontrado");
      }
      const documents: SyncDocument[] = [];

      const portfolio = new PortfolioAggregator();
      for await (const page of this.ingestion.iteratePositions(clientId)) {
        for (const p of page) portfolio.add(p);
      }
      const carteira = portfolio.build();
      if (carteira) documents.push(carteira);

      // Janela de 12 meses ancorada na transação mais recente (ordem `date desc`).
      let newest: string | undefined;
      for await (const page of this.ingestion.iterateTransactions(clientId, { pageSize: 1 })) {
        newest = page[0]?.date;
        break;
      }
      if (newest !== undefined) {
        const flow = new CashFlowAggregator(newest);
        for await (const page of this.ingestion.iterateTransactions(clientId, {
          from: flow.from,
        })) {
          for (const t of page) flow.add(t);
        }
        const fluxo = flow.build();
        if (fluxo) documents.push(fluxo);
      }

      for (const doc of documents) {
        await TenantContext.withClient(clientId, () =>
          this.knowledge.ingestDocument({ source: SYNC_SOURCE, ...doc }),
        );
      }
      return { documents: documents.length };
    });
  }

  /** Handler do stream: só `data.ingested`; erro permanente é logado e confirmado. */
  async handle(event: StreamEvent): Promise<void> {
    if (event.type !== "data.ingested") return;
    const fields = {
      eventId: event.eventId,
      tenantId: logId(event.tenantId),
      clientId: logId(event.clientId),
    };
    try {
      await this.syncClient(event.tenantId, event.clientId);
    } catch (err) {
      if (err instanceof ValidationError || err instanceof NotFoundError) {
        this.logger.warn({ msg: "Evento data.ingested descartado pelo Sync", err, ...fields });
        return;
      }
      this.logger.error({
        msg: "Sync do cliente falhou; o evento será reentregue",
        err,
        ...fields,
      });
      throw err;
    }
  }

  /** `consume` só termina sozinho quando abortado; se falhar (ex.: Redis fora), tenta de novo. */
  private async consumeUntilAborted(signal: AbortSignal): Promise<void> {
    const consumer = `${hostname()}-${process.pid.toString()}`;
    while (!signal.aborted) {
      try {
        await this.streams.consume({
          stream: SYNC_STREAM,
          group: SYNC_GROUP,
          consumer,
          handler: (e) => this.handle(e),
          signal,
        });
      } catch (err) {
        if (signal.aborted) break;
        this.logger.error({ msg: "Consumo do stream jobs pelo Sync falhou; reiniciando", err });
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, RESTART_DELAY_MS);
          signal.addEventListener("abort", done, { once: true });
        });
      }
    }
  }
}

/** Provider do logger do worker (substituível em testes com `overrideProvider`). */
export const syncLoggerProvider = {
  provide: SYNC_LOGGER,
  useFactory: (): SyncLogger => new Logger(SyncWorker.name),
};
