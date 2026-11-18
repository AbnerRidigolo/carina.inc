/**
 * SQL/Prisma das importações de arquivo (import_job e import_file), sempre sob o
 * TenantPrismaService (RLS por tenant e cliente). As escritas do upload recebem a `tx` do serviço,
 * com o cliente já fixado; as leituras abrem a própria transação (também com o cliente fixado).
 * Os métodos do worker (claim/finish/limpeza) entram aqui, na Task 10.
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

  /** Auditoria da criação: só rótulos fixos, nunca o nome nem o conteúdo do arquivo. */
  async insertAudit(tx: Tx): Promise<void> {
    const { tenantId, clientId } = this.pinned();
    await tx.auditEvent.create({
      data: {
        tenantId,
        clientId,
        channel: "import",
        query: "import.created",
        agents: [],
        responseDigest: null,
        flags: [],
        durationMs: 0,
      },
      select: { id: true },
    });
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
