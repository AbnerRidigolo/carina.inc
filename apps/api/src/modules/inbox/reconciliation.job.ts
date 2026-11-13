/**
 * Reconciliação da inbox (spec §6.2), a cada minuto: o banco é a fonte da verdade e o stream é só
 * o gatilho. Por tenant:
 *   1. `pending` vencida → `expired` e `resume { approved: false }`;
 *   2. `approved` sem `executed_action` há mais de 2 min → republica `resume { approved: true }`;
 *   3. `executed_action.started` há mais de 5 min → `needs_review`. NUNCA reexecuta: não se sabe se
 *      o efeito externo aconteceu (ver o cabeçalho do InboxService).
 *
 * - Tenants: `active_tenant_ids()` (SECURITY DEFINER, migrations/0004) devolve só os que têm linha
 *   não terminal; cada um é processado sob `TenantContext.run({ tenantId })` com o papel
 *   carina_app (RLS normal). O app nunca usa o papel migrator.
 * - Várias réplicas: cada tick pega um lock curto no Redis (`inbox:reconciliation:lock`, com
 *   heartbeat); quem não pega pula o tick. Por baixo, cada mudança de estado é um UPDATE
 *   condicional com `FOR UPDATE SKIP LOCKED … RETURNING`: mesmo sem o lock, só uma réplica "ganha"
 *   cada linha, então `resume` de expiração e a marcação needs_review não duplicam.
 * - Relógio: tudo pelo CLOCK injetado (testes avançam o tempo).
 * - Ciclo de vida: `setInterval` (unref) só com WORKERS_ENABLED !== "false", limpo em
 *   `onModuleDestroy`/`beforeApplicationShutdown`, que esperam o tick em andamento terminar
 *   (antes de o RedisModule fechar a conexão).
 * - Um tenant que falha é registrado (só ids) e não impede os demais; lotes de até BATCH linhas
 *   por passo e por tick (o resto fica para o próximo).
 */
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
import { INBOX_LOGGER, publishResume, type InboxLogger } from "./inbox.service.js";

export const RECONCILIATION_INTERVAL_MS = 60_000;
export const RECONCILIATION_LOCK_KEY = "inbox:reconciliation:lock";
const LOCK_TTL_MS = 50_000;
const APPROVED_GRACE_MS = 2 * 60_000;
const STARTED_STALE_MS = 5 * 60_000;
const BATCH = 500;

interface ApprovalRef {
  id: string;
  client_id: string;
  thread_id: string;
}

export interface ReconciliationRun {
  /** Outra réplica estava com o lock. */
  skipped: boolean;
  tenants: number;
}

@Injectable()
export class ReconciliationJob
  implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown
{
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<unknown> | undefined;

  constructor(
    @Inject(ENV) private readonly env: Pick<Env, "WORKERS_ENABLED">,
    @Inject(TenantPrismaService) private readonly db: TenantPrismaService,
    @Inject(StreamsService) private readonly streams: StreamsService,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(INBOX_LOGGER) private readonly logger: InboxLogger,
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
          this.logger.error({ msg: "Tick da reconciliação da inbox falhou", err });
        })
        .finally(() => {
          if (this.inflight === tick) this.inflight = undefined;
        });
      this.inflight = tick;
    }, RECONCILIATION_INTERVAL_MS);
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
   * tenants: os testes compartilham o banco e um tick com o relógio adiantado venceria (ou marcaria
   * needs_review) as linhas de outros arquivos rodando em paralelo. O timer nunca o passa.
   *
   * @internal `onlyTenants` existe só para os testes; código de produção chama `run()` sem opções.
   */
  async run(opts: { onlyTenants?: readonly string[] } = {}): Promise<ReconciliationRun> {
    const lock = await this.locks.acquire(RECONCILIATION_LOCK_KEY, LOCK_TTL_MS);
    if (!lock) return { skipped: true, tenants: 0 };
    try {
      const only = opts.onlyTenants?.map((id) => id.toLowerCase());
      const active = await this.db.activeTenantIds();
      const tenantIds = only ? active.filter((id) => only.includes(id.toLowerCase())) : active;
      for (const tenantId of tenantIds) {
        await lock.assertHeld(); // perdeu o lock: aborta o tick (LockLostError)
        try {
          await TenantContext.run({ tenantId }, () => this.reconcileTenant(tenantId));
        } catch (err) {
          this.logger.error({ msg: "Reconciliação da inbox falhou para o tenant", err, tenantId });
        }
      }
      return { skipped: false, tenants: tenantIds.length };
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  private async reconcileTenant(tenantId: string): Promise<void> {
    const now = this.clock();
    const nowIso = new Date(now).toISOString();
    const approvedBefore = new Date(now - APPROVED_GRACE_MS).toISOString();
    const startedBefore = new Date(now - STARTED_STALE_MS).toISOString();

    // 1. vencidas → expired
    const expired = await this.db.tx(
      (tx) =>
        tx.$queryRaw<ApprovalRef[]>`
        UPDATE approval_request SET status = 'expired'
        WHERE id IN (
          SELECT id FROM approval_request
          WHERE status = 'pending' AND expires_at <= ${nowIso}::timestamptz
          ORDER BY expires_at, id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING id, client_id, thread_id`,
    );
    for (const row of expired) {
      await publishResume(this.streams, this.logger, {
        tenantId,
        clientId: row.client_id,
        approvalId: row.id,
        threadId: row.thread_id,
        approved: false,
      });
    }

    // 2. approved sem execução há > 2 min → republica resume
    const stuck = await this.db.tx(
      (tx) =>
        tx.$queryRaw<ApprovalRef[]>`
        SELECT a.id, a.client_id, a.thread_id FROM approval_request a
        WHERE a.status = 'approved' AND a.decided_at <= ${approvedBefore}::timestamptz
          AND NOT EXISTS (SELECT 1 FROM executed_action e WHERE e.approval_request_id = a.id)
        ORDER BY a.decided_at, a.id LIMIT ${BATCH}`,
    );
    for (const row of stuck) {
      await publishResume(this.streams, this.logger, {
        tenantId,
        clientId: row.client_id,
        approvalId: row.id,
        threadId: row.thread_id,
        approved: true,
      });
    }

    // 3. started há > 5 min → needs_review (nunca reexecuta)
    const review = await this.db.tx(
      (tx) =>
        tx.$queryRaw<{ approval_request_id: string; client_id: string }[]>`
        UPDATE executed_action SET status = 'needs_review', finished_at = ${nowIso}::timestamptz
        WHERE approval_request_id IN (
          SELECT approval_request_id FROM executed_action
          WHERE status = 'started' AND started_at <= ${startedBefore}::timestamptz
          ORDER BY started_at, approval_request_id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING approval_request_id, client_id`,
    );
    for (const row of review) {
      this.logger.warn({
        msg: "Execução presa em started marcada como needs_review (não será reexecutada)",
        tenantId,
        clientId: row.client_id,
        approvalId: row.approval_request_id,
      });
    }
  }
}
