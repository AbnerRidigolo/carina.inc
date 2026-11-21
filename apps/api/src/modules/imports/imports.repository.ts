/**
 * SQL/Prisma das importações de arquivo (import_job e import_file), sempre sob o
 * TenantPrismaService (RLS por tenant e cliente). As escritas do upload recebem a `tx` do serviço,
 * com o cliente já fixado; as leituras abrem a própria transação (também com o cliente fixado).
 * O worker usa `claim`/`touchProgress`/`finish` com o cliente fixado; a limpeza usa
 * `expireFiles`/`failStuck` só com o tenant fixado (todos os clientes dele).
 */
import {
  ImportStatsSchema,
  type ImportFailureCode,
  type ImportFormat,
  type ImportJobView,
  type ImportOptions,
  type ImportRowError,
  type ImportStats,
} from "@carina/shared";
import { Inject, Injectable } from "@nestjs/common";
import { TenantContext } from "../../core/context/tenant-context.js";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { ClientRef } from "../tenancy/clients.service.js";

type Tx = Prisma.TransactionClient;

export const EMPTY_STATS: ImportStats = {
  rowsRead: 0,
  positions: 0,
  transactions: 0,
  errorRows: 0,
  ignored: {},
};

export interface ExistingJob {
  id: string;
  status: string;
}

export interface NewJob {
  format: ImportFormat;
  fileName: string;
  fileSha256: string;
  options: ImportOptions;
}

const VIEW_SELECT = {
  id: true,
  format: true,
  fileName: true,
  status: true,
  failureCode: true,
  stats: true,
  errors: true,
  createdAt: true,
  updatedAt: true,
} as const;

type ViewRow = Prisma.ImportJobGetPayload<{ select: typeof VIEW_SELECT }>;

/** Job tomado pelo worker: o que o parse e a gravação precisam (opções ainda não validadas). */
export interface ClaimedJob {
  job: { id: string; format: ImportFormat; options: unknown; client: ClientRef };
  /** Token deste claim: `touchProgress` e `finish` só valem com ele. */
  claimToken: string;
  bytes: Uint8Array;
}

export interface JobOutcome {
  status: "done" | "failed";
  failureCode: ImportFailureCode | null;
  stats: ImportStats;
  errors: ImportRowError[];
}

/** Job fechado pela limpeza (para o evento `import.finished`). */
export interface ClosedJob {
  id: string;
  clientId: string;
}

/** Máximo de jobs fechados por passo da limpeza; o resto fica para o próximo tick. */
export const CLEANUP_BATCH = 500;

/** Linha do banco → contrato público. `stats` de jobs ainda sem parse completa com zeros. */
export function toView(row: ViewRow): ImportJobView {
  const stats = ImportStatsSchema.safeParse({
    ...EMPTY_STATS,
    ...(row.stats as object),
  });
  return {
    id: row.id,
    format: row.format as ImportFormat,
    fileName: row.fileName,
    status: row.status as ImportJobView["status"],
    failureCode: row.failureCode as ImportFailureCode | null,
    stats: stats.success ? stats.data : EMPTY_STATS,
    errors: row.errors as ImportRowError[],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class ImportsRepository {
  constructor(@Inject(TenantPrismaService) private readonly db: TenantPrismaService) {}

  /**
   * Serializa os uploads do mesmo cliente até o fim da transação: sem isso, dois envios do mesmo
   * arquivo (ou o 5º e o 6º job) correriam entre a verificação e a gravação.
   */
  async lockUploads(tx: Tx): Promise<void> {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
        'import_upload',
        current_setting('app.tenant_id', true),
        current_setting('app.client_id', true)
      )::text, 0)) IS NULL AS locked`;
  }

  /** Job do cliente fixado com esse SHA-256, se houver. */
  findBySha(tx: Tx, fileSha256: string): Promise<ExistingJob | null> {
    return tx.importJob.findFirst({
      where: { fileSha256 },
      select: { id: true, status: true },
    });
  }

  /** Jobs `queued`/`parsing` do cliente fixado. */
  countActive(tx: Tx): Promise<number> {
    return tx.importJob.count({ where: { status: { in: ["queued", "parsing"] } } });
  }

  async insertQueued(tx: Tx, job: NewJob): Promise<string> {
    const { tenantId, clientId } = this.pinned();
    const row = await tx.importJob.create({
      data: {
        tenantId,
        clientId,
        format: job.format,
        fileName: job.fileName,
        fileSha256: job.fileSha256,
        status: "queued",
        stats: EMPTY_STATS,
        errors: [],
        options: job.options,
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Reenfileira um job `failed`: opções novas, `stats`/`errors` zerados, sem código de falha.
   * Devolve `false` se o job já não está `failed` (outro processo o mexeu).
   */
  async requeue(tx: Tx, id: string, options: ImportOptions, fileName: string): Promise<boolean> {
    const res = await tx.importJob.updateMany({
      where: { id, status: "failed" },
      data: {
        status: "queued",
        failureCode: null,
        stats: EMPTY_STATS,
        errors: [],
        options,
        fileName,
        progressAt: new Date(),
        updatedAt: new Date(),
      },
    });
    return res.count === 1;
  }

  /** Grava (ou regrava) os bytes do job; há no máximo uma linha por job. */
  async insertFile(tx: Tx, importJobId: string, bytes: Buffer): Promise<void> {
    const { tenantId, clientId } = this.pinned();
    // Mesma memória do Buffer, só com o tipo que o Prisma exige (sem copiar até 10 MB).
    const data = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.length);
    await tx.importFile.upsert({
      where: { importJobId },
      create: { importJobId, tenantId, clientId, bytes: data },
      update: { bytes: data, createdAt: new Date() },
    });
  }

  /**
   * Auditoria (`import.created`, `import.finished:<status>`): só rótulos fixos, nunca o nome nem
   * o conteúdo do arquivo.
   */
  async insertAudit(tx: Tx, query = "import.created"): Promise<void> {
    const { tenantId, clientId } = this.pinned();
    await tx.auditEvent.create({
      data: {
        tenantId,
        clientId,
        channel: "import",
        query,
        agents: [],
        responseDigest: null,
        flags: [],
        durationMs: 0,
      },
      select: { id: true },
    });
  }

  /**
   * Toma o job para o worker: `queued` → `parsing` (UPDATE condicional, atômico: duas entregas
   * do mesmo evento não tomam o job duas vezes) e lê os bytes e o cliente. `null` se o job não
   * está `queued`, não tem bytes, ou não é do cliente fixado: não há o que fazer. Cada claim
   * grava um `claim_token` novo: um worker que travou e perdeu o job (stuck → reenvio → outro
   * claim) não consegue mais avançá-lo nem fechá-lo.
   */
  async claim(jobId: string): Promise<ClaimedJob | null> {
    return this.db.tx(async (tx) => {
      const rows = await tx.$queryRaw<
        { format: string; options: unknown; client_id: string; claim_token: string }[]
      >`
        UPDATE import_job
        SET status = 'parsing', claim_token = gen_random_uuid(), progress_at = now(),
            updated_at = now()
        WHERE id = ${jobId}::uuid AND status = 'queued'
          AND EXISTS (SELECT 1 FROM import_file f WHERE f.import_job_id = import_job.id)
        RETURNING format, options, client_id, claim_token`;
      const row = rows[0];
      if (row === undefined) return null;
      const file = await tx.importFile.findUniqueOrThrow({
        where: { importJobId: jobId },
        select: { bytes: true },
      });
      const client = await tx.client.findUniqueOrThrow({
        where: { id: row.client_id },
        select: { id: true, externalId: true },
      });
      return {
        job: { id: jobId, format: row.format as ImportFormat, options: row.options, client },
        bytes: file.bytes,
        claimToken: row.claim_token,
      };
    });
  }

  /**
   * Marca avanço do job (`progress_at`); `false` se ele já não está `parsing` com o token deste
   * claim (foi tirado pela limpeza, e talvez tomado de novo por outro worker).
   */
  async touchProgress(jobId: string, claimToken: string): Promise<boolean> {
    const res = await this.db.client.importJob.updateMany({
      where: { id: jobId, status: "parsing", claimToken },
      data: { progressAt: new Date(), updatedAt: new Date() },
    });
    return res.count === 1;
  }

  /**
   * Fecha o job (`done`/`failed`) e apaga os bytes NA MESMA transação `tx`. Só fecha um job ainda
   * `parsing` com o token deste claim: se a limpeza o tirou do worker (stuck) e ele foi
   * reenviado (e talvez tomado por outro worker), nada muda e os bytes novos ficam.
   */
  async finish(tx: Tx, jobId: string, claimToken: string, outcome: JobOutcome): Promise<boolean> {
    const res = await tx.importJob.updateMany({
      where: { id: jobId, status: "parsing", claimToken },
      data: {
        status: outcome.status,
        failureCode: outcome.failureCode,
        stats: outcome.stats,
        errors: outcome.errors as Prisma.InputJsonValue,
        progressAt: new Date(),
        updatedAt: new Date(),
      },
    });
    if (res.count !== 1) return false;
    await tx.importFile.deleteMany({ where: { importJobId: jobId } });
    return true;
  }

  /**
   * Limpeza, com só o tenant fixado: apaga os `import_file` criados antes de `olderThan` e marca
   * `failed`/`expired` os jobs deles que ainda estavam `queued`/`parsing` (com auditoria), numa
   * transação. O `import_job` nunca é apagado (o cursor da lista depende dele).
   */
  async expireFiles(olderThan: Date): Promise<ClosedJob[]> {
    return this.db.tx(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; client_id: string }[]>`
        WITH old AS (
          SELECT import_job_id FROM import_file
          WHERE created_at < ${olderThan.toISOString()}::timestamptz
          ORDER BY created_at LIMIT ${CLEANUP_BATCH} FOR UPDATE SKIP LOCKED
        ), gone AS (
          DELETE FROM import_file f USING old WHERE f.import_job_id = old.import_job_id
          RETURNING f.import_job_id
        )
        UPDATE import_job j
        SET status = 'failed', failure_code = 'expired', updated_at = now()
        FROM gone WHERE j.id = gone.import_job_id AND j.status IN ('queued', 'parsing')
        RETURNING j.id, j.client_id`;
      return this.closed(tx, rows);
    });
  }

  /**
   * Limpeza, com só o tenant fixado: jobs `parsing` sem progresso desde antes de `olderThan` →
   * `failed`/`stuck`, com os bytes apagados e auditoria, numa transação.
   */
  async failStuck(olderThan: Date): Promise<ClosedJob[]> {
    return this.db.tx(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; client_id: string }[]>`
        WITH stuck AS (
          SELECT id FROM import_job
          WHERE status = 'parsing' AND progress_at < ${olderThan.toISOString()}::timestamptz
          ORDER BY progress_at LIMIT ${CLEANUP_BATCH} FOR UPDATE SKIP LOCKED
        ), closed AS (
          UPDATE import_job j
          SET status = 'failed', failure_code = 'stuck', updated_at = now()
          FROM stuck WHERE j.id = stuck.id
          RETURNING j.id, j.client_id
        ), gone AS (
          DELETE FROM import_file f USING closed WHERE f.import_job_id = closed.id
        )
        SELECT id, client_id FROM closed`;
      return this.closed(tx, rows);
    });
  }

  /** Auditoria dos jobs fechados pela limpeza, na transação dela. */
  private async closed(tx: Tx, rows: { id: string; client_id: string }[]): Promise<ClosedJob[]> {
    if (rows.length === 0) return [];
    const { tenantId } = TenantContext.current();
    await tx.auditEvent.createMany({
      data: rows.map((r) => ({
        tenantId,
        clientId: r.client_id,
        channel: "import",
        query: "import.finished:failed",
        agents: [],
        responseDigest: null,
        flags: [],
        durationMs: 0,
      })),
    });
    return rows.map((r) => ({ id: r.id, clientId: r.client_id }));
  }

  /** Job do cliente fixado (RLS); `null` se não existe nele. */
  async get(id: string): Promise<ImportJobView | null> {
    const row = await this.db.client.importJob.findUnique({
      where: { id },
      select: VIEW_SELECT,
    });
    return row ? toView(row) : null;
  }

  /** Visão de um job dentro da transação do upload. */
  async view(tx: Tx, id: string): Promise<ImportJobView> {
    const row = await tx.importJob.findUniqueOrThrow({ where: { id }, select: VIEW_SELECT });
    return toView(row);
  }

  /**
   * Mais recentes primeiro, keyset por `(created_at, id)`. `after` é o id do último job da página
   * anterior; a comparação é feita no banco (microssegundos, sem passar por `Date`). Pede
   * `take + 1` para saber se há próxima página.
   */
  async list(
    take: number,
    after: string | undefined,
  ): Promise<{ items: ImportJobView[]; hasMore: boolean; last?: string }> {
    const ids = await this.db.tx(async (tx) => {
      const rows =
        after === undefined
          ? await tx.$queryRaw<{ id: string }[]>`
              SELECT id FROM import_job ORDER BY created_at DESC, id DESC LIMIT ${take + 1}`
          : await tx.$queryRaw<{ id: string }[]>`
              SELECT id FROM import_job
              WHERE (created_at, id) < (SELECT created_at, id FROM import_job WHERE id = ${after}::uuid)
              ORDER BY created_at DESC, id DESC LIMIT ${take + 1}`;
      const pageIds = rows.slice(0, take).map((r) => r.id);
      const found = await tx.importJob.findMany({
        where: { id: { in: pageIds } },
        select: VIEW_SELECT,
      });
      const byId = new Map(found.map((r) => [r.id, toView(r)]));
      return {
        items: pageIds.flatMap((id) => byId.get(id) ?? []),
        hasMore: rows.length > take,
      };
    });
    const last = ids.items.at(-1)?.id;
    return { ...ids, ...(last !== undefined ? { last } : {}) };
  }

  private pinned(): { tenantId: string; clientId: string } {
    const { tenantId, clientId } = TenantContext.current();
    if (clientId === undefined) throw new Error("Importação exige o cliente fixado no contexto");
    return { tenantId, clientId };
  }
}
