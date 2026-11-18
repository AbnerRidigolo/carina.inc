/**
 * Importação de arquivos: recebe o upload, valida de forma síncrona (nada gravado nem cobrado em
 * caso de recusa), guarda o job e os bytes na MESMA transação e, só depois do COMMIT, publica
 * `import.requested` em `jobs` (o worker da Task 10 faz o parse). Sem conteúdo nem nome de arquivo
 * em log ou auditoria (LGPD).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  ImportOptionsSchema,
  type ImportFormat,
  type ImportJobList,
  type ImportJobView,
  type ImportOptions,
  type ImportUploadFields,
} from "@carina/shared";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { TenantContext } from "../../core/context/tenant-context.js";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import {
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from "../../core/errors/domain-errors.js";
import { StreamsService } from "../../core/redis/streams.service.js";
import { ClientsService } from "../tenancy/clients.service.js";
import { sanitizeFileName } from "./file-name.js";
import { CSV_PRESETS } from "./parsers/csv-presets.js";
import { detectFormat } from "./parsers/detect.js";
import { ImportsRepository } from "./imports.repository.js";

export const MAX_ACTIVE_IMPORTS = 5;
export const ACTIVE_RETRY_AFTER_SECONDS = 30;
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

export interface ImportsLogFields {
  msg: string;
  err?: unknown;
  [field: string]: unknown;
}

export interface ImportsLogger {
  error(fields: ImportsLogFields): void;
}

export const IMPORTS_LOGGER = Symbol("IMPORTS_LOGGER");

export interface UploadedFile {
  bytes: Buffer;
  originalName?: string | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cursor opaco da lista: base64url do id do último job da página. */
const encodeCursor = (id: string): string => Buffer.from(id, "utf8").toString("base64url");

function decodeCursor(raw: string): string {
  const invalid = () => new ValidationError("after não é um cursor válido");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) throw invalid();
  const id = Buffer.from(raw, "base64url").toString("utf8");
  if (!UUID_RE.test(id)) throw invalid();
  return id;
}

/** Texto do campo do upload; vazio (só espaços) conta como ausente. */
const present = (v: string | undefined): string | undefined =>
  v === undefined || v.trim() === "" ? undefined : v;

/** Monta e valida `ImportOptions` a partir dos campos do upload e do formato detectado. */
function buildOptions(format: ImportFormat, f: ImportUploadFields): ImportOptions {
  let candidate: Record<string, unknown>;
  if (format === "ofx") {
    candidate = { format };
  } else if (format === "b3_xlsx") {
    const asOf = present(f.asOf);
    candidate = { format, ...(asOf !== undefined ? { asOf } : {}) };
  } else {
    const preset = present(f.csvPreset);
    const rawMapping = present(f.csvMapping);
    let mapping: unknown;
    if (rawMapping !== undefined) {
      try {
        mapping = JSON.parse(rawMapping);
      } catch {
        throw new ValidationError("csvMapping precisa ser um JSON válido");
      }
    }
    const presetInstitution =
      preset !== undefined && Object.hasOwn(CSV_PRESETS, preset)
        ? CSV_PRESETS[preset as keyof typeof CSV_PRESETS].institution
        : undefined;
    const institution = present(f.institution) ?? presetInstitution;
    const account = present(f.account);
    candidate = {
      format,
      ...(institution !== undefined ? { institution } : {}),
      ...(account !== undefined ? { account } : {}),
      ...(preset !== undefined ? { csvPreset: preset } : {}),
      ...(mapping !== undefined ? { csvMapping: mapping } : {}),
    };
  }
  const parsed = ImportOptionsSchema.safeParse(candidate);
  if (!parsed.success) {
    // Só caminho e mensagem fixa do schema; nunca o valor enviado.
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`)
      .join("; ");
    throw new ValidationError(`Opções da importação inválidas (${detail})`);
  }
  return parsed.data;
}

@Injectable()
export class ImportsService {
  constructor(
    @Inject(ClientsService) private readonly clients: ClientsService,
    @Inject(TenantPrismaService) private readonly db: TenantPrismaService,
    @Inject(ImportsRepository) private readonly repo: ImportsRepository,
    @Inject(StreamsService) private readonly streams: StreamsService,
    @Inject(IMPORTS_LOGGER) private readonly logger: ImportsLogger,
  ) {}

  /**
   * `created: false` (HTTP 200): o mesmo arquivo já está `queued`, `parsing` ou `done` e nada
   * mudou. `created: true` (202): job novo, ou job `failed` reenfileirado.
   */
  async create(
    clientExternalId: string,
    file: UploadedFile,
    fields: ImportUploadFields,
  ): Promise<{ job: ImportJobView; created: boolean }> {
    if (file.bytes.length === 0) throw new ValidationError("O arquivo está vazio");
    const format = detectFormat(file.bytes);
    if (format === null) throw new ValidationError("Formato de arquivo não reconhecido");
    if (fields.format !== undefined && fields.format !== format) {
      throw new ValidationError("O formato informado não corresponde ao conteúdo do arquivo");
    }
    const options = buildOptions(format, fields);
    const fileName = sanitizeFileName(file.originalName);
    const fileSha256 = createHash("sha256").update(file.bytes).digest("hex");

    const { tenantId } = TenantContext.current();
    const client = await this.clients.resolve(clientExternalId, { create: true });

    const out = await TenantContext.withClient(client.id, () =>
      this.db.tx(async (tx) => {
        await this.repo.lockUploads(tx);
        const existing = await this.repo.findBySha(tx, fileSha256);
        if (existing !== null && existing.status !== "failed") {
          return { job: await this.repo.view(tx, existing.id), created: false };
        }
        // Job novo e reenfileiramento de `failed` ocupam uma vaga: o teto vale para os dois.
        if ((await this.repo.countActive(tx)) >= MAX_ACTIVE_IMPORTS) {
          throw new RateLimitedError(
            `Há ${MAX_ACTIVE_IMPORTS} importações em andamento para este cliente; tente novamente em instantes`,
            ACTIVE_RETRY_AFTER_SECONDS,
          );
        }
        if (existing !== null) {
          if (await this.repo.requeue(tx, existing.id, options, fileName)) {
            await this.repo.insertFile(tx, existing.id, file.bytes);
            return { job: await this.repo.view(tx, existing.id), created: true };
          }
          return { job: await this.repo.view(tx, existing.id), created: false };
        }
        const id = await this.repo.insertQueued(tx, { format, fileName, fileSha256, options });
        await this.repo.insertFile(tx, id, file.bytes);
        await this.repo.insertAudit(tx);
        return { job: await this.repo.view(tx, id), created: true };
      }),
    );

    if (out.created) await this.notify(tenantId, client.id, out.job.id);
    return out;
  }

  /** Cliente ou job inexistente (ou de outro tenant) → NotFoundError. */
  async get(clientExternalId: string, id: string): Promise<ImportJobView> {
    const client = await this.clients.resolve(clientExternalId);
    if (!UUID_RE.test(id)) throw notFound();
    const job = await TenantContext.withClient(client.id, () => this.repo.get(id));
    if (job === null) throw notFound();
    return job;
  }

  /** Mais recentes primeiro; `after` é o `nextCursor` da página anterior. */
  async list(
    clientExternalId: string,
    opts: { limit?: number; after?: string } = {},
  ): Promise<ImportJobList> {
    const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new ValidationError(`limit precisa ser um inteiro entre 1 e ${MAX_LIST_LIMIT}`);
    }
    const after = opts.after === undefined ? undefined : decodeCursor(opts.after);
    const client = await this.clients.resolve(clientExternalId);
    const page = await TenantContext.withClient(client.id, () => this.repo.list(limit, after));
    return {
      items: page.items,
      nextCursor: page.hasMore && page.last !== undefined ? encodeCursor(page.last) : null,
    };
  }

  /** Depois do COMMIT e em melhor esforço: o job já está gravado e `queued`. */
  private async notify(tenantId: string, clientId: string, importJobId: string): Promise<void> {
    try {
      await this.streams.publish("jobs", {
        eventId: randomUUID(),
        type: "import.requested",
        tenantId,
        clientId,
        importJobId,
      });
    } catch (err) {
      this.logger.error({
        msg: "Falha ao publicar import.requested; o job ficou queued",
        err,
        tenantId,
        clientId,
        importJobId,
      });
    }
  }
}

function notFound(): NotFoundError {
  return new NotFoundError("Importação não encontrada");
}

/** Provider do logger do serviço (substituível em testes com `overrideProvider`). */
export const importsLoggerProvider = {
  provide: IMPORTS_LOGGER,
  useFactory: (): ImportsLogger => new Logger(ImportsService.name),
};
