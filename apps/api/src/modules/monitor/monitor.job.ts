/**
 * Vigilância da carteira (spec §4.1, §4.4–4.5), no worker, a cada `MONITOR_INTERVAL_MS`:
 *   1. fora do pregão (`marketStateAt(clock)`), ciclo vazio: não toma lock, não lê posições nem cota;
 *   2. lock global no Redis (`monitor:tick`) ANTES de cotar: outra réplica com o lock → ciclo
 *      pulado. O `monitorQuotes` não tem busca única por símbolo e conta com este lock;
 *   3. tenants por `monitor_tenant_ids()` (SECURITY DEFINER), cada um sob `TenantContext.run`
 *      (RLS, só o tenant fixado): pares (cliente, ativo) distintos das posições de investimento;
 *   4. rodízio: a união ordenada dos símbolos; o cursor (`monitor:<modo>:cursor`) guarda o último cotado e
 *      o ciclo pega os próximos `MONITOR_MAX_SYMBOLS_PER_TICK` depois dele, até o fim da lista; o
 *      ciclo seguinte ao fim recomeça do início. Orçamento do monitor esgotado no meio → o cursor
 *      avança até o símbolo anterior ao primeiro que o `monitorQuotes` não chegou a tentar
 *      (`pending`), sem erro: nada fica pulado, e um símbolo tentado que o provedor não conhece
 *      conta como feito (não trava o rodízio, mesmo com o cache negativo já expirado). Um lote em
 *      que o provedor falha também conta como tentado (o `monitorQuotes` não lança por ele): um
 *      símbolo ruim não trava o monitor de todos os tenants;
 *   5. regra `detectMove` (só cotação do mesmo dia de São Paulo e com idade até
 *      `MARKET_QUOTE_MAX_AGE_MS`: nada de alerta "de hoje" com o fechamento de ontem); cada alerta numa transação própria (`insertIfNew`, idempotente por
 *      cliente, ativo, dia de São Paulo e sentido): um insert que falha é logado (só ids) e os
 *      demais seguem; o que entrou é publicado como `monitor.alert` em `inbox.events` DEPOIS do
 *      COMMIT, em melhor esforço.
 *
 * Como a ImportCleanupJob: relógio pelo CLOCK; `setInterval` unref só com WORKERS_ENABLED !==
 * "false", parado em `onModuleDestroy`/`beforeApplicationShutdown` esperando o ciclo em andamento;
 * um tenant que falha é logado (só ids) e não impede os demais; lock perdido aborta o ciclo.
 * Redis fora: o lock (ou o orçamento do `monitorQuotes`) lança e o ciclo é logado como falho.
 *
 * Logs só com ids e contagens: nenhum código de ativo, variação, preço ou valor de posição.
 */
import { randomUUID } from "node:crypto";
import type { PortfolioAlert } from "@carina/shared";
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { Redis } from "ioredis";
import { ENV } from "../../core/config/config.module.js";
import type { Env } from "../../core/config/env.js";
import { TenantContext } from "../../core/context/tenant-context.js";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import { LockService } from "../../core/redis/lock.service.js";
import { REDIS } from "../../core/redis/redis.tokens.js";
import { StreamsService } from "../../core/redis/streams.service.js";
import { errorFields } from "../imports/import.worker.js";
import { CLOCK, type Clock } from "../limits/clock.js";
import { SYMBOL_RE } from "../market/asset-class.js";
import { marketStateAt, saoPauloDate } from "../market/market-hours.js";
import { MarketService } from "../market/market.service.js";
import { type DetectedMove, type MonitorMode, detectMove } from "./detect-move.js";
import { MonitorRepository, type WatchItem } from "./monitor.repository.js";

export const MONITOR_LOCK_KEY = "monitor:tick";
/**
 * Cursor do rodízio, por modo (`monitor:<modo>:cursor`): um Redis compartilhado entre mock e live
 * não faz um modo retomar do ponto do outro (as listas de símbolos diferem).
 */
export const monitorCursorKey = (mode: MonitorMode): string => `monitor:${mode}:cursor`;
/** TTL do lock; o heartbeat do LockService o renova enquanto o ciclo roda. */
const LOCK_TTL_MS = 2 * 60_000;

/** Logger do job, provido por `monitorLoggerProvider` (substituível com `overrideProvider`). */
export const MONITOR_LOGGER = Symbol("MONITOR_LOGGER");

/** Forma de OBJETO no 1º argumento (nestjs-pino). Só ids e contagens. */
export interface MonitorLogFields {
  msg: string;
  [field: string]: unknown;
}

export interface MonitorLogger {
  info(fields: MonitorLogFields): void;
  warn(fields: MonitorLogFields): void;
  error(fields: MonitorLogFields): void;
}

export const monitorLoggerProvider = {
  provide: MONITOR_LOGGER,
  useFactory: (): MonitorLogger => {
    const logger = new Logger(MonitorJob.name);
    return {
      info: (fields) => logger.log(fields),
      warn: (fields) => logger.warn(fields),
      error: (fields) => logger.error(fields),
    };
  },
};

export type MonitorEnv = Pick<
  Env,
  | "WORKERS_ENABLED"
  | "MARKET_MODE"
  | "MARKET_QUOTE_MAX_AGE_MS"
  | "MONITOR_INTERVAL_MS"
  | "MONITOR_MAX_SYMBOLS_PER_TICK"
  | "MONITOR_MOVE_THRESHOLD_PCT"
>;

export interface MonitorRun {
  /** Outra réplica estava com o lock. */
  skipped: boolean;
  /** Fora do pregão: nada foi lido nem cotado. */
  closed: boolean;
  tenants: number;
  /** Símbolos pedidos ao `monitorQuotes` neste ciclo (o lote do rodízio). */
  symbols: number;
  /** Alertas gravados (e publicados) neste ciclo. */
  alerts: number;
  /** O orçamento do monitor esgotou no meio do lote. */
  exhausted: boolean;
}

const EMPTY_RUN: MonitorRun = {
  skipped: false,
  closed: false,
  tenants: 0,
  symbols: 0,
  alerts: 0,
  exhausted: false,
};

/**
 * Lote do rodízio: até `max` símbolos de `sorted` depois de `cursor` (o primeiro estritamente
 * maior; um cursor que saiu da lista não trava), até o fim da lista; sem nada depois, recomeça.
 */
export function nextBatch(sorted: readonly string[], cursor: string | null, max: number): string[] {
  const after = cursor === null ? 0 : sorted.findIndex((s) => s > cursor);
  const from = after === -1 ? 0 : after;
  return sorted.slice(from, from + max);
}

/**
 * Novo cursor do rodízio: o símbolo anterior ao primeiro não tentado (`pending`, por falta de
 * orçamento); sem pendentes, o fim do lote. `undefined` = não anda (nada do lote foi tentado).
 * Tentado e ausente do provedor conta como feito.
 */
export function advanceCursor(
  batch: readonly string[],
  pending: readonly string[],
): string | undefined {
  const first = pending[0];
  if (first === undefined) return batch.at(-1);
  const idx = batch.indexOf(first);
  if (idx === -1) return batch.at(-1);
  return idx === 0 ? undefined : batch[idx - 1];
}

@Injectable()
export class MonitorJob
  implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown
{
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<unknown> | undefined;

  constructor(
    @Inject(ENV) private readonly env: MonitorEnv,
    @Inject(TenantPrismaService) private readonly db: TenantPrismaService,
    @Inject(MonitorRepository) private readonly repo: MonitorRepository,
    @Inject(MarketService) private readonly market: MarketService,
    @Inject(StreamsService) private readonly streams: StreamsService,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MONITOR_LOGGER) private readonly logger: MonitorLogger,
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
      if (this.inflight) return; // ciclo anterior ainda rodando
      const tick = this.runOnce()
        .catch((err: unknown) => {
          this.logger.error({ msg: "Ciclo do monitor de carteira falhou", ...errorFields(err) });
        })
        .finally(() => {
          if (this.inflight === tick) this.inflight = undefined;
        });
      this.inflight = tick;
    }, this.env.MONITOR_INTERVAL_MS);
    this.timer.unref();
  }

  /** Para o timer e espera o ciclo em andamento (idempotente). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inflight;
  }

  /**
   * Um ciclo completo (também chamado direto pelos testes). `onlyTenants` restringe o ciclo a esses
   * tenants: os testes compartilham o banco.
   *
   * @internal `onlyTenants` existe só para os testes; o timer chama `runOnce()` sem opções.
   */
  async runOnce(opts: { onlyTenants?: readonly string[] } = {}): Promise<MonitorRun> {
    const now = this.clock();
    if (marketStateAt(now) !== "open") return { ...EMPTY_RUN, closed: true };

    const lock = await this.locks.acquire(MONITOR_LOCK_KEY, LOCK_TTL_MS);
    if (!lock) return { ...EMPTY_RUN, skipped: true };
    try {
      const only = opts.onlyTenants?.map((id) => id.toLowerCase());
      const found = await this.repo.tenantIds();
      const tenantIds = only ? found.filter((id) => only.includes(id.toLowerCase())) : found;

      const watch = new Map<string, WatchItem[]>();
      for (const tenantId of tenantIds) {
        try {
          const items = await TenantContext.run({ tenantId }, () =>
            this.db.tx((tx) => this.repo.watchList(tx)),
          );
          watch.set(tenantId, items);
        } catch (err) {
          this.logger.error({
            msg: "Monitor de carteira: falha ao ler as posições do tenant",
            ...errorFields(err),
            tenantId,
          });
        }
      }

      // Só códigos que o MarketService aceita: um código fora do padrão derrubaria o lote todo.
      const all = [...new Set([...watch.values()].flat().map((i) => i.assetCode))]
        .filter((s) => SYMBOL_RE.test(s))
        .sort();
      if (all.length === 0) return this.summary({ ...EMPTY_RUN, tenants: tenantIds.length });

      const batch = nextBatch(
        all,
        await this.redis.get(monitorCursorKey(this.env.MARKET_MODE)),
        this.env.MONITOR_MAX_SYMBOLS_PER_TICK,
      );
      await lock.assertHeld();
      const { quotes, exhausted, pending } = await this.market.monitorQuotes(batch);

      const cursor = advanceCursor(batch, pending);
      if (cursor !== undefined) {
        await lock.assertHeld();
        await this.redis.set(monitorCursorKey(this.env.MARKET_MODE), cursor);
      }

      const tradingDay = saoPauloDate(now);
      const rule = {
        thresholdPct: this.env.MONITOR_MOVE_THRESHOLD_PCT,
        mode: this.env.MARKET_MODE,
        nowMs: now,
        tradingDay,
        maxAgeMs: this.env.MARKET_QUOTE_MAX_AGE_MS,
      };
      const moves = new Map<string, DetectedMove>();
      for (const quote of quotes) {
        const move = detectMove(quote, rule);
        if (move) moves.set(quote.symbol, move);
      }

      let alerts = 0;
      for (const [tenantId, items] of watch) {
        const hits = items.filter((i) => moves.has(i.assetCode));
        if (hits.length === 0) continue;
        await lock.assertHeld(); // perdeu o lock: aborta o ciclo (LockLostError)
        try {
          alerts += await TenantContext.run({ tenantId }, () =>
            this.record(tenantId, hits, moves, tradingDay),
          );
        } catch (err) {
          this.logger.error({
            msg: "Monitor de carteira falhou para o tenant",
            ...errorFields(err),
            tenantId,
          });
        }
      }

      return this.summary({
        ...EMPTY_RUN,
        tenants: tenantIds.length,
        symbols: batch.length,
        alerts,
        exhausted,
      });
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  /** Log do ciclo (só contagens) e o próprio resultado. */
  private summary(run: MonitorRun): MonitorRun {
    this.logger.info({
      msg: "Ciclo do monitor de carteira",
      tenants: run.tenants,
      symbols: run.symbols,
      alerts: run.alerts,
      exhausted: run.exhausted,
    });
    return run;
  }

  /** Grava os alertas do tenant (sob o contexto dele), cada um na sua transação; devolve quantos. */
  private async record(
    tenantId: string,
    hits: readonly WatchItem[],
    moves: ReadonlyMap<string, DetectedMove>,
    tradingDay: string,
  ): Promise<number> {
    let inserted = 0;
    for (const { clientId, assetCode } of hits) {
      const move = moves.get(assetCode);
      if (!move) continue;
      let alert: PortfolioAlert | null;
      try {
        alert = await this.db.tx((tx) =>
          this.repo.insertIfNew(tx, {
            clientId,
            assetCode,
            direction: move.direction,
            changePct: move.changePct,
            price: move.price,
            tradingDay,
          }),
        );
      } catch (err) {
        this.logger.error({
          msg: "Monitor de carteira: falha ao gravar o alerta",
          ...errorFields(err),
          tenantId,
          clientId,
        });
        continue;
      }
      if (alert === null) continue;
      inserted++;
      await this.publish(tenantId, clientId, alert);
    }
    return inserted;
  }

  /** `monitor.alert` em `inbox.events`, depois do COMMIT, em melhor esforço. */
  private async publish(tenantId: string, clientId: string, alert: PortfolioAlert): Promise<void> {
    try {
      await this.streams.publish("inbox.events", {
        eventId: randomUUID(),
        type: "monitor.alert",
        tenantId,
        clientId,
        alert,
      });
    } catch (err) {
      this.logger.error({
        msg: "Falha ao publicar monitor.alert",
        ...errorFields(err),
        tenantId,
        clientId,
      });
    }
  }
}
