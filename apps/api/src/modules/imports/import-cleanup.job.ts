/**
 * Limpeza periódica da importação (spec §5.6), a cada 5 minutos:
 *   1. `import_file` criado há mais de 1 h → apagado, e o job (se `queued`/`parsing`) vira
 *      `failed`/`expired` (ex.: `import.requested` que não chegou ao worker);
 *   2. job `parsing` sem progresso há mais de 15 min → `failed`/`stuck` e o `import_file` apagado
 *      (worker que caiu no meio). O reenvio do mesmo arquivo reenfileira o job (ImportsService).
 * Cada job fechado ganha auditoria `import.finished:failed` e um `import.finished` em
 * `inbox.events` (para a web). O `import_job` nunca é apagado: o cursor da lista depende dele.
 *
 * Como a ReconciliationJob: tenants por `import_cleanup_tenant_ids()` (SECURITY DEFINER,
 * migrations/0008), cada um sob `TenantContext.run({ tenantId })` (RLS normal, todos os clientes
 * do tenant); um lock global no Redis (`imports:cleanup`) por tick, e por baixo UPDATE/DELETE com
 * `FOR UPDATE SKIP LOCKED`; relógio pelo CLOCK; `setInterval` unref só com WORKERS_ENABLED !==
 * "false", parado em `onModuleDestroy`/`beforeApplicationShutdown` esperando o tick em andamento.
 * Um tenant que falha é registrado (só ids) e não impede os demais.
 */
import { randomUUID } from "node:crypto";
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ENV } from "../../core/config/config.module.js";
import type { Env } from "../../core/config/env.js";
import { TenantContext } from "../../core/context/tenant-context.js";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import { LockService } from "../../core/redis/lock.service.js";
import { StreamsService } from "../../core/redis/streams.service.js";
import { CLOCK, type Clock } from "../limits/clock.js";
import { errorFields, IMPORT_LOGGER, type ImportLogger } from "./import.worker.js";
import { type ClosedJob, ImportsRepository } from "./imports.repository.js";

export const IMPORT_CLEANUP_INTERVAL_MS = 5 * 60_000;
export const IMPORT_CLEANUP_LOCK_KEY = "imports:cleanup";
export const IMPORT_FILE_TTL_MS = 60 * 60_000;
export const IMPORT_STUCK_AFTER_MS = 15 * 60_000;
const LOCK_TTL_MS = 4 * 60_000;

export interface ImportCleanupRun {
  /** Outra réplica estava com o lock. */
  skipped: boolean;
  tenants: number;
  expired: number;
  stuck: number;
}

@Injectable()
export class ImportCleanupJob
  implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown
{
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<unknown> | undefined;

  constructor(
    @Inject(ENV) private readonly env: Pick<Env, "WORKERS_ENABLED">,
    @Inject(TenantPrismaService) private readonly db: TenantPrismaService,
    @Inject(ImportsRepository) private readonly repo: ImportsRepository,
    @Inject(StreamsService) private readonly streams: StreamsService,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(IMPORT_LOGGER) private readonly logger: ImportLogger,
  ) {}

  /** O timer está ligado. */
  get running(): boolean {
    return this.timer !== undefined;
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

  /** Liga o timer (idempotente). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inflight) return; // tick anterior ainda rodando
      const tick = this.run()
        .catch((err: unknown) => {
          this.logger.error({ msg: "Tick da limpeza da importação falhou", ...errorFields(err) });
        })
        .finally(() => {
          if (this.inflight === tick) this.inflight = undefined;
        });
      this.inflight = tick;
    }, IMPORT_CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  /** Para o timer e espera o tick em andamento (idempotente). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inflight;
  }

  /**
   * Um tick completo (também chamado direto pelos testes). `onlyTenants` restringe o tick a esses
   * tenants: os testes compartilham o banco.
   *
   * @internal `onlyTenants` existe só para os testes; o timer chama `run()` sem opções.
   */
  async run(opts: { onlyTenants?: readonly string[] } = {}): Promise<ImportCleanupRun> {
    const lock = await this.locks.acquire(IMPORT_CLEANUP_LOCK_KEY, LOCK_TTL_MS);
    if (!lock) return { skipped: true, tenants: 0, expired: 0, stuck: 0 };
    try {
      const now = this.clock();
      const filesBefore = new Date(now - IMPORT_FILE_TTL_MS);
      const stuckBefore = new Date(now - IMPORT_STUCK_AFTER_MS);
      const only = opts.onlyTenants?.map((id) => id.toLowerCase());
      const found = await this.db.importCleanupTenantIds(filesBefore, stuckBefore);
      const tenantIds = only ? found.filter((id) => only.includes(id.toLowerCase())) : found;
      let expired = 0;
      let stuck = 0;
      for (const tenantId of tenantIds) {
        await lock.assertHeld(); // perdeu o lock: aborta o tick (LockLostError)
        try {
          await TenantContext.run({ tenantId }, async () => {
            const gone = await this.repo.expireFiles(filesBefore);
            expired += gone.length;
            const halted = await this.repo.failStuck(stuckBefore);
            stuck += halted.length;
            await this.notify(tenantId, [...gone, ...halted]);
          });
        } catch (err) {
          this.logger.error({
            msg: "Limpeza da importação falhou para o tenant",
            ...errorFields(err),
            tenantId,
          });
        }
      }
      return { skipped: false, tenants: tenantIds.length, expired, stuck };
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  /** `import.finished { failed }` dos jobs fechados, em melhor esforço. */
  private async notify(tenantId: string, jobs: ClosedJob[]): Promise<void> {
    for (const job of jobs) {
      try {
        await this.streams.publish("inbox.events", {
          eventId: randomUUID(),
          type: "import.finished",
          tenantId,
          clientId: job.clientId,
          importJobId: job.id,
          status: "failed",
        });
      } catch (err) {
        this.logger.error({
          msg: "Falha ao publicar import.finished da limpeza",
          ...errorFields(err),
          tenantId,
          clientId: job.clientId,
          importJobId: job.id,
        });
      }
    }
  }
}
