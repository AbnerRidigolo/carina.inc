/**
 * Worker de importação (spec §5.1, §5.5, §5.6): consome `import.requested` no stream `jobs`
 * (grupo `imports`), faz o parse numa worker thread e grava pelo IngestionService.
 *
 * Fluxo de um job, com o tenant do evento em `TenantContext.run` e o cliente fixado por
 * `withClient` (RLS):
 *   1. `claim` (`queued` → `parsing`, atômico): `null` → já tomado, reentrega, sem bytes ou de
 *      outro cliente: ACK sem efeito. Se o próprio claim falhar (ex.: banco fora), o erro é
 *      relançado e o StreamsService reentrega: nada foi tomado, então repetir é seguro.
 *   2. `import.progress { stage: "parsing" }`; `parseFile` (thread, 30 s); `failure` → `failed`.
 *   3. B3 com posições → `replaceImportedPositions` (fotografia mais antiga que a gravada →
 *      todas as posições viram erro `stale_snapshot`, nada substituído).
 *   4. Transações em lotes de 1000 por `upsertTransactionsFor` (cada lote gravado ⇔ cobrado, e
 *      `data.ingested` por lote); depois de cada lote, `touchProgress` e
 *      `import.progress { stage: "writing", processed, total }`.
 *   5. Nada gravado → `failed`/`no_valid_rows`; senão `done`. `finish` (status + DELETE do
 *      import_file) e a auditoria `import.finished:<status>` numa transação; depois do COMMIT,
 *      `import.finished` em `inbox.events`.
 * Erro inesperado depois do claim → `failed`/`internal` em melhor esforço, com os `stats` do que
 * já foi gravado, e ACK: não há reentrega (os bytes podem já ter saído; o usuário reenvia, e o
 * upsert idempotente não duplica). `touchProgress` e `finish` levam o token do claim: se a limpeza
 * tirou o job do worker (`stuck`), mesmo que um reenvio já o tenha posto de novo em `parsing`
 * com outro worker, `touchProgress` → false e o worker para de gravar sem fechar nada.
 *
 * LGPD: logs e eventos levam só ids, contadores e códigos fixos. Nunca `stats.ignored` (as chaves
 * podem ter texto de célula), linhas, valores ou descrições; de um erro, só nome e código (a
 * mensagem de um erro do Prisma pode citar os argumentos da consulta).
 *
 * Ciclo de vida como o SyncWorker: liga em `onApplicationBootstrap` só com WORKERS_ENABLED !==
 * "false"; `stop` aborta o consumo (e a thread de parse em andamento) e espera o loop terminar.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  type ImportRowError,
  type ImportStats,
  ImportOptionsSchema,
  MAX_IMPORT_ERRORS,
  type StreamEvent,
} from "@carina/shared";
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
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import { StreamsService } from "../../core/redis/streams.service.js";
import { IngestionService, MAX_BATCH_ITEMS } from "../data-ingestion/ingestion.service.js";
import {
  type ClaimedJob,
  EMPTY_STATS,
  ImportsRepository,
  type JobOutcome,
} from "./imports.repository.js";
import { parseFile } from "./parse-file.js";
import { ROW_ERROR_MESSAGES } from "./parsers/row-errors.js";

export const IMPORT_STREAM = "jobs";
export const IMPORT_GROUP = "imports";
const RESTART_DELAY_MS = 1000;

/** Forma de OBJETO no 1º argumento (nestjs-pino), como no SyncWorker. Só ids e contadores. */
export interface ImportLogFields {
  msg: string;
  [field: string]: unknown;
}

export interface ImportLogger {
  info(fields: ImportLogFields): void;
  warn(fields: ImportLogFields): void;
  error(fields: ImportLogFields): void;
}

export const IMPORT_LOGGER = Symbol("IMPORT_LOGGER");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Id vindo do evento, só para log: cortado (o schema do stream aceita qualquer texto). */
const logId = (value: string) => value.slice(0, 64);

/** De um erro, só o que não carrega conteúdo: nome e código. */
export function errorFields(err: unknown): { errName: string; errCode?: string } {
  const name = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  return { errName: name, ...(typeof code === "string" ? { errCode: code.slice(0, 32) } : {}) };
}

/** A limpeza tirou o job do worker (`stuck`) no meio da gravação. */
class JobTakenError extends Error {
  constructor() {
    super("O job deixou de estar em parsing");
    this.name = "JobTakenError";
  }
}

/** Estado acumulado do job, para fechar com o que foi gravado mesmo num erro no meio. */
interface Progress {
  stats: ImportStats;
  errors: ImportRowError[];
}

type ImportEvent =
  | { type: "import.progress"; stage: "parsing" | "writing"; processed: number; total: number }
  | { type: "import.finished"; status: "done" | "failed" };

@Injectable()
export class ImportWorker
  implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown
{
  private abort: AbortController | undefined;
  private loop: Promise<void> | undefined;
  /** Sinal usado pelos `handle` chamados fora do loop (testes): nunca aborta. */
  private readonly idle = new AbortController();

  constructor(
    @Inject(ENV) private readonly env: Pick<Env, "WORKERS_ENABLED">,
    @Inject(StreamsService) private readonly streams: StreamsService,
    @Inject(TenantPrismaService) private readonly db: TenantPrismaService,
    @Inject(ImportsRepository) private readonly repo: ImportsRepository,
    @Inject(IngestionService) private readonly ingestion: IngestionService,
    @Inject(IMPORT_LOGGER) private readonly logger: ImportLogger,
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

  /** Handler do stream: só `import.requested`; os demais tipos são confirmados sem efeito. */
  async handle(event: StreamEvent): Promise<void> {
    if (event.type !== "import.requested") return;
    const ids = {
      eventId: event.eventId,
      tenantId: logId(event.tenantId),
      clientId: logId(event.clientId),
      importJobId: logId(event.importJobId),
    };
    if (![event.tenantId, event.clientId, event.importJobId].every((id) => UUID_RE.test(id))) {
      this.logger.warn({ msg: "Evento import.requested com id inválido descartado", ...ids });
      return;
    }
    await TenantContext.run({ tenantId: event.tenantId }, () =>
      TenantContext.withClient(event.clientId, () =>
        this.process(event.tenantId, event.clientId, event.importJobId, ids),
      ),
    );
  }

  private async process(
    tenantId: string,
    clientId: string,
    jobId: string,
    ids: Record<string, string>,
  ): Promise<void> {
    let claimed: ClaimedJob | null;
    try {
      claimed = await this.repo.claim(jobId);
    } catch (err) {
      this.logger.error({
        msg: "Falha ao tomar o job de importação; o evento será reentregue",
        ...errorFields(err),
        ...ids,
      });
      throw err;
    }
    if (claimed === null) {
      this.logger.info({ msg: "Job de importação já tomado ou sem arquivo; nada a fazer", ...ids });
      return;
    }

    const progress: Progress = { stats: { ...EMPTY_STATS, ignored: {} }, errors: [] };
    let outcome: JobOutcome;
    try {
      await this.publish(tenantId, clientId, jobId, {
        type: "import.progress",
        stage: "parsing",
        processed: 0,
        total: 0,
      });
      outcome = await this.runJob(claimed, progress, (e) =>
        this.publish(tenantId, clientId, jobId, e),
      );
    } catch (err) {
      if (err instanceof JobTakenError) {
        this.logger.warn({
          msg: "Job de importação tirado do worker pela limpeza; gravação interrompida",
          ...ids,
        });
        return;
      }
      this.logger.error({
        msg: "Importação falhou com erro inesperado; job marcado failed",
        ...errorFields(err),
        ...ids,
      });
      outcome = { status: "failed", failureCode: "internal", ...progress };
    }

    try {
      await this.close(tenantId, clientId, jobId, claimed.claimToken, outcome, ids);
    } catch (err) {
      this.logger.error({
        msg: "Falha ao fechar o job de importação; a limpeza o marcará stuck",
        ...errorFields(err),
        ...ids,
      });
    }
  }

  /** Parse e gravação; devolve o desfecho. `progress` acompanha o que já foi gravado. */
  private async runJob(
    claimed: ClaimedJob,
    progress: Progress,
    emit: (e: ImportEvent) => Promise<void>,
  ): Promise<JobOutcome> {
    const { job, bytes, claimToken } = claimed;
    const options = ImportOptionsSchema.parse(job.options);
    const parsed = await parseFile(
      job.format,
      bytes,
      options,
      this.abort?.signal ?? this.idle.signal,
    );
    progress.stats = { ...parsed.stats, positions: 0, transactions: 0 };
    progress.errors = [...parsed.errors];
    if (parsed.failure !== undefined) {
      return { status: "failed", failureCode: parsed.failure, ...progress };
    }

    let written = 0;
    if (parsed.positions.length > 0) {
      const asOf = options.format === "b3_xlsx" ? options.asOf : undefined;
      if (asOf === undefined) throw new TypeError("Posições sem a data da fotografia");
      const res = await this.ingestion.replaceImportedPositions(job.client, {
        institutions: parsed.positionInstitutions ?? [],
        asOf,
        items: parsed.positions,
      });
      if (res.stale) {
        for (let i = 0; i < parsed.positions.length; i++) {
          if (progress.errors.length >= MAX_IMPORT_ERRORS) break;
          progress.errors.push({
            row: 0,
            field: "asOf",
            code: "stale_snapshot",
            message: ROW_ERROR_MESSAGES.stale_snapshot,
          });
        }
        progress.stats.errorRows += parsed.positions.length;
      } else {
        progress.stats.positions = res.upserted;
        written += res.upserted;
      }
      if (!(await this.repo.touchProgress(job.id, claimToken))) throw new JobTakenError();
    }

    const total = parsed.transactions.length;
    for (let start = 0; start < total; start += MAX_BATCH_ITEMS) {
      const batch = parsed.transactions.slice(start, start + MAX_BATCH_ITEMS);
      const res = await this.ingestion.upsertTransactionsFor(job.client, "import", batch);
      progress.stats.transactions += res.upserted;
      written += res.upserted;
      if (!(await this.repo.touchProgress(job.id, claimToken))) throw new JobTakenError();
      await emit({
        type: "import.progress",
        stage: "writing",
        processed: start + batch.length,
        total,
      });
    }

    if (written === 0) return { status: "failed", failureCode: "no_valid_rows", ...progress };
    return { status: "done", failureCode: null, ...progress };
  }

  /** `finish` + auditoria numa transação; `import.finished` só depois do COMMIT. */
  private async close(
    tenantId: string,
    clientId: string,
    jobId: string,
    claimToken: string,
    outcome: JobOutcome,
    ids: Record<string, string>,
  ): Promise<void> {
    const closed = await this.db.tx(async (tx) => {
      if (!(await this.repo.finish(tx, jobId, claimToken, outcome))) return false;
      await this.repo.insertAudit(tx, `import.finished:${outcome.status}`);
      return true;
    });
    if (!closed) {
      this.logger.warn({ msg: "Job de importação já não estava em parsing; não fechado", ...ids });
      return;
    }
    this.logger.info({
      msg: "Importação concluída",
      status: outcome.status,
      failureCode: outcome.failureCode,
      positions: outcome.stats.positions,
      transactions: outcome.stats.transactions,
      errorRows: outcome.stats.errorRows,
      ...ids,
    });
    await this.publish(tenantId, clientId, jobId, {
      type: "import.finished",
      status: outcome.status,
    });
  }

  /** Evento para a web em `inbox.events`, em melhor esforço (o estado está no banco). */
  private async publish(
    tenantId: string,
    clientId: string,
    importJobId: string,
    e: ImportEvent,
  ): Promise<void> {
    try {
      await this.streams.publish("inbox.events", {
        eventId: randomUUID(),
        tenantId,
        clientId,
        importJobId,
        ...e,
      });
    } catch (err) {
      this.logger.error({
        msg: `Falha ao publicar ${e.type}`,
        ...errorFields(err),
        tenantId,
        clientId,
        importJobId,
      });
    }
  }

  /** `consume` só termina sozinho quando abortado; se falhar (ex.: Redis fora), tenta de novo. */
  private async consumeUntilAborted(signal: AbortSignal): Promise<void> {
    const consumer = `${hostname()}-${process.pid.toString()}`;
    while (!signal.aborted) {
      try {
        await this.streams.consume({
          stream: IMPORT_STREAM,
          group: IMPORT_GROUP,
          consumer,
          handler: (e) => this.handle(e),
          signal,
        });
      } catch (err) {
        if (signal.aborted) break;
        this.logger.error({
          msg: "Consumo do stream jobs pela importação falhou; reiniciando",
          ...errorFields(err),
        });
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
export const importLoggerProvider = {
  provide: IMPORT_LOGGER,
  useFactory: (): ImportLogger => {
    const logger = new Logger(ImportWorker.name);
    return {
      info: (fields) => logger.log(fields),
      warn: (fields) => logger.warn(fields),
      error: (fields) => logger.error(fields),
    };
  },
};
