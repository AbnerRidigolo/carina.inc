/**
 * Agenda e disparos manuais dos AOPs (spec §4.4), no worker.
 *
 * Agenda, a cada `AOP_TICK_MS` (padrão do MonitorJob):
 *   1. lock global no Redis (`aops:tick`, com heartbeat): outra réplica com o lock → ciclo pulado;
 *   2. tenants por `aop_tenant_ids()` (SECURITY DEFINER), cada um sob `TenantContext.run` (RLS);
 *   3. AOPs habilitados do tenant; os vencidos (`isDue`, fuso de São Paulo) disparam no horário
 *      agendado (`previousFire`) pelo disparo idempotente `claimFire`: só quem ganha o UPDATE
 *      condicional roda (réplica concorrente com o lock já expirado, ciclo repetido);
 *   4. `AopRunner.run(aop, { fireAt, trigger: "schedule" })`.
 * Um AOP ou tenant que falha é logado (só ids) e não impede os demais; lock perdido aborta o ciclo
 * (`assertHeld` antes de cada disparo). O disparo é no máximo uma vez: se o worker cai depois do
 * `claimFire`, aquele horário não roda de novo (sem cobrança dupla).
 *
 * Manual: consome `aop.run_requested` no stream `jobs` (grupo `aops`). NÃO usa `claimFire` nem
 * `last_fire_at` (engoliria o disparo agendado ainda pendente): o `fireAt` do evento (o instante do
 * pedido) vira `aop_run.fire_at`, e a idempotência vem do único `(aop_id, client_id, fire_at)`: o
 * runner pula o cliente que já tem execução nesse `fireAt` e desfaz a cobrança numa corrida. Um lock
 * por disparo (`aops:manual:<aopId>:<fireAt>`) impede que uma reentrega concorrente (reclaim de uma
 * execução longa) rode os agentes em paralelo à primeira. Erro inesperado sobe: o stream reentrega
 * e o runner continua de onde parou. AOP inexistente ou desligado: ACK sem efeito. O limite de 1
 * disparo manual por minuto é da rota.
 *
 * Ciclo de vida: timer `unref` e consumidor só com WORKERS_ENABLED !== "false"; `stop` (no
 * `onModuleDestroy`/`beforeApplicationShutdown`) para os dois e espera o ciclo e o consumo em
 * andamento. Logs só com ids e contagens.
 */
import { hostname } from "node:os";
import type { Aop, StreamEvent } from "@carina/shared";
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
import { type LockHandle, LockService } from "../../core/redis/lock.service.js";
import { StreamsService } from "../../core/redis/streams.service.js";
import { errorFields } from "../imports/import.worker.js";
import { CLOCK, type Clock } from "../limits/clock.js";
import { AOP_LOGGER, type AopLogger, AopRunner } from "./aop-runner.js";
import { AopsRepository } from "./aops.repository.js";
import { isDue, previousFire } from "./schedule.js";

export const AOP_LOCK_KEY = "aops:tick";
export const AOP_STREAM = "jobs";
export const AOP_GROUP = "aops";
/** Lock de um disparo manual: uma execução por vez do mesmo AOP e instante. */
export const aopManualLockKey = (aopId: string, fireAt: string): string =>
  `aops:manual:${aopId}:${fireAt}`;
/** TTL dos locks; o heartbeat do LockService os renova enquanto o ciclo/execução roda. */
const LOCK_TTL_MS = 2 * 60_000;
const RESTART_DELAY_MS = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Id vindo do evento, só para log: cortado. */
const logId = (value: string) => value.slice(0, 64);

export type AopJobEnv = Pick<Env, "WORKERS_ENABLED" | "AOP_TICK_MS">;

export interface AopTick {
  /** Outra réplica estava com o lock. */
  skipped: boolean;
  tenants: number;
  /** Disparos ganhos (`claimFire`) neste ciclo. */
  fired: number;
  /** Disparos cuja execução falhou (logados). */
  failed: number;
}

@Injectable()
export class AopJob implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<unknown> | undefined;
  private abort: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(ENV) private readonly env: AopJobEnv,
    @Inject(TenantPrismaService) private readonly db: Pick<TenantPrismaService, "tx">,
    @Inject(AopsRepository)
    private readonly repo: Pick<AopsRepository, "tenantIds" | "dueAops" | "claimFire" | "get">,
    @Inject(AopRunner) private readonly runner: Pick<AopRunner, "run">,
    @Inject(StreamsService) private readonly streams: Pick<StreamsService, "consume">,
    @Inject(LockService) private readonly locks: Pick<LockService, "acquire">,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AOP_LOGGER) private readonly logger: AopLogger,
  ) {}

  /** O timer e o consumidor estão ligados. */
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

  /** Liga o timer da agenda e o consumidor dos disparos manuais (idempotente). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inflight) return; // ciclo anterior ainda rodando
      const tick = this.runOnce()
        .catch((err: unknown) => {
          this.logger.error({ msg: "Ciclo da agenda dos AOPs falhou", ...errorFields(err) });
        })
        .finally(() => {
          if (this.inflight === tick) this.inflight = undefined;
        });
      this.inflight = tick;
    }, this.env.AOP_TICK_MS);
    this.timer.unref();
    const abort = new AbortController();
    this.abort = abort;
    this.loop = this.consumeUntilAborted(abort.signal);
  }

  /** Para o timer e o consumidor e espera o que está em andamento (idempotente). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    await Promise.all([this.inflight, this.loop]);
    this.abort = undefined;
    this.loop = undefined;
  }

  /**
   * Um ciclo da agenda (também chamado direto pelos testes).
   *
   * @internal `onlyTenants` existe só para os testes (o banco é compartilhado).
   */
  async runOnce(opts: { onlyTenants?: readonly string[] } = {}): Promise<AopTick> {
    const lock = await this.locks.acquire(AOP_LOCK_KEY, LOCK_TTL_MS);
    if (!lock) return { skipped: true, tenants: 0, fired: 0, failed: 0 };
    try {
      const only = opts.onlyTenants?.map((id) => id.toLowerCase());
      const found = await this.repo.tenantIds();
      const tenantIds = only ? found.filter((id) => only.includes(id.toLowerCase())) : found;
      const tick: AopTick = { skipped: false, tenants: tenantIds.length, fired: 0, failed: 0 };
      for (const tenantId of tenantIds) {
        await lock.assertHeld();
        let aops: Aop[];
        try {
          aops = await TenantContext.run({ tenantId }, () =>
            this.db.tx((tx) => this.repo.dueAops(tx)),
          );
        } catch (err) {
          this.logger.error({
            msg: "Agenda dos AOPs: falha ao ler os AOPs do tenant",
            ...errorFields(err),
            tenantId,
          });
          continue;
        }
        for (const aop of aops) await this.fireScheduled(tenantId, aop, lock, tick);
      }
      this.logger.info({
        msg: "Ciclo da agenda dos AOPs",
        tenants: tick.tenants,
        fired: tick.fired,
        failed: tick.failed,
      });
      return tick;
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  /** Dispara o AOP se vencido e se este ciclo ganhar o `claimFire`. */
  private async fireScheduled(
    tenantId: string,
    aop: Aop,
    lock: Pick<LockHandle, "assertHeld">,
    tick: AopTick,
  ): Promise<void> {
    const now = this.clock();
    const lastFireAt = aop.lastFireAt === null ? null : new Date(aop.lastFireAt);
    if (!isDue(aop.schedule, now, lastFireAt)) return;
    const fireAt = previousFire(aop.schedule, now);
    await lock.assertHeld(); // perdeu o lock: aborta o ciclo (LockLostError)
    try {
      await TenantContext.run({ tenantId }, async () => {
        const claimed = await this.db.tx((tx) => this.repo.claimFire(tx, aop.id, fireAt));
        if (!claimed) return;
        tick.fired++;
        try {
          await this.runner.run(aop, { fireAt, trigger: "schedule" });
        } catch (err) {
          tick.failed++;
          throw err;
        }
      });
    } catch (err) {
      this.logger.error({
        msg: "Agenda dos AOPs: execução falhou",
        ...errorFields(err),
        tenantId,
        aopId: aop.id,
      });
    }
  }

  /** Handler do stream: só `aop.run_requested`; os demais tipos são confirmados sem efeito. */
  async handle(event: StreamEvent): Promise<void> {
    if (event.type !== "aop.run_requested") return;
    const ids = {
      eventId: event.eventId,
      tenantId: logId(event.tenantId),
      aopId: logId(event.aopId),
    };
    if (!UUID_RE.test(event.tenantId) || !UUID_RE.test(event.aopId)) {
      this.logger.warn({ msg: "Evento aop.run_requested com id inválido descartado", ...ids });
      return;
    }
    const fireAt = new Date(event.fireAt);
    await TenantContext.run({ tenantId: event.tenantId }, async () => {
      const aop = await this.db.tx((tx) => this.repo.get(tx, event.aopId));
      if (aop === null || !aop.enabled) {
        this.logger.warn({
          msg: "Disparo manual de AOP inexistente ou desligado ignorado",
          ...ids,
        });
        return;
      }
      const lock = await this.locks.acquire(
        aopManualLockKey(aop.id, fireAt.toISOString()),
        LOCK_TTL_MS,
      );
      if (!lock) {
        this.logger.info({ msg: "Disparo manual do AOP já em execução; nada a fazer", ...ids });
        return;
      }
      try {
        await this.runner.run(aop, { fireAt, trigger: "manual" });
      } finally {
        await lock.release().catch(() => undefined);
      }
    });
  }

  /** `consume` só termina sozinho quando abortado; se falhar (ex.: Redis fora), tenta de novo. */
  private async consumeUntilAborted(signal: AbortSignal): Promise<void> {
    const consumer = `${hostname()}-${process.pid.toString()}`;
    while (!signal.aborted) {
      try {
        await this.streams.consume({
          stream: AOP_STREAM,
          group: AOP_GROUP,
          consumer,
          handler: (e) => this.handle(e),
          signal,
        });
      } catch (err) {
        if (signal.aborted) break;
        this.logger.error({
          msg: "Consumo do stream jobs pelos AOPs falhou; reiniciando",
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
