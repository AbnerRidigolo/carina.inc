/**
 * Worker de retomada (spec §6.2): consome `resume` no stream `jobs` (grupo `resumers`) e retoma o
 * grafo do orquestrador depois da decisão humana (InboxService.decide) ou da expiração / da
 * republicação feitas pela ReconciliationJob. Os demais tipos de evento recebem ACK sem efeito
 * (outros consumidores de `jobs` usam grupos próprios).
 *
 * ── O evento é só um SINAL ─────────────────────────────────────────────────────────────────────
 * A decisão vem do BANCO: `OrchestratorService.resume` e o nó `approval` leem a aprovação gravada;
 * `approved` do evento não decide nada. Do evento só se usam os ids, e só depois de conferidos:
 *   - `tenantId` e `clientId` precisam ser uuid e IGUAIS (sem diferenciar caixa) aos do prefixo do
 *     `threadId` (`tenantId:clientId:<id>`), e `approvalId` precisa ter o formato de id de
 *     aprovação. Só então o trabalho roda sob `TenantContext.run({ tenantId, clientId })`. Um
 *     evento que não confere é forjado ou corrompido: log de ERRO (só ids, cortados) e ACK.
 *   - O thread precisa estar esperando ESTA aprovação (`pending.approvalId` do checkpoint igual
 *     ao `approvalId` do evento). Senão (thread inexistente, já em outro turno, outra aprovação):
 *     o evento está velho ou forjado; warn e ACK, sem retomar.
 *
 * ── Matriz ACK / retentativa ───────────────────────────────────────────────────────────────────
 *   formato inválido (JSON/schema)          → StreamsService manda para `jobs.dlq` (antes do handler)
 *   outro tipo de evento                    → ACK, sem efeito
 *   ids não conferem com o thread / formato → log error + ACK (nunca executa; não adianta retentar)
 *   thread sem esta aprovação pendente      → log warn + ACK
 *   NotFoundError do orquestrador           → TERMINAL: log warn + ACK, nunca retenta
 *   ValidationError do orquestrador         → permanente: log error + ACK
 *   ApprovalConflictError (banco `pending`) → log warn e relança: sem ACK; o XAUTOCLAIM reentrega
 *                                             depois de `claimIdleMs` (a espera entre tentativas)
 *                                             e a DLQ recebe o evento na 5ª entrega
 *   qualquer outro erro                     → log error e relança (mesma reentrega/DLQ)
 *   sucesso (inclusive thread já resolvido) → log info com o status e ACK
 *
 * ── Recuperação de um `resume` que foi para a DLQ ──────────────────────────────────────────────
 *   - de aprovação `approved`: a ReconciliationJob republica `resume` (approved sem
 *     executed_action há > 2 min), então o thread é retomado e a execução acontece (uma vez);
 *   - de aprovação `rejected`/`expired`: nada republica; quem cura é o guard do
 *     `OrchestratorService.stream`, que no próximo turno lê o banco e fecha a espera pelo caminho
 *     do `resume` (grava `rejected`, nada executa) antes de seguir;
 *   - em qualquer caso, um replay manual da DLQ (republicar o evento em `jobs`) continua possível
 *     e é seguro (a decisão vem do banco; a cerca impede execução dupla).
 *
 * ── No máximo uma vez ──────────────────────────────────────────────────────────────────────────
 * Quem garante é a cerca do `InboxService.executeOnce` (INSERT em executed_action com PK por
 * aprovação, commitado antes do executor). Reentrega, eventos duplicados (mesmo eventId: o dedup
 * do StreamsService só dá ACK; outro eventId: `resume` devolve a execução gravada) e dois workers
 * no mesmo grupo (XAUTOCLAIM de uma entrada ainda em andamento) chegam no máximo a uma execução.
 *
 * ── Logs ───────────────────────────────────────────────────────────────────────────────────────
 * Forma de objeto `{ msg, err, ...ids }` (nestjs-pino: `err` no topo, serializado com stack). Só
 * ids (eventId, tenantId, clientId, approvalId, threadId) e o status da execução; nunca payload.
 *
 * ── Ciclo de vida ──────────────────────────────────────────────────────────────────────────────
 * Liga em `onApplicationBootstrap` só com WORKERS_ENABLED !== "false"; para em `onModuleDestroy`
 * (antes do módulo fechar o checkpointer e do RedisModule global fechar a conexão) abortando o
 * consumo e esperando o loop, o que inclui a mensagem em andamento, por no máximo
 * RESUME_STOP_TIMEOUT_MS (30 s, configurável pelo token RESUME_STOP_TIMEOUT). Sem timers
 * pendurados.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { StreamEvent } from "@carina/shared";
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { ENV } from "../../core/config/config.module.js";
import type { Env } from "../../core/config/env.js";
import { TenantContext } from "../../core/context/tenant-context.js";
import {
  ApprovalConflictError,
  NotFoundError,
  ValidationError,
} from "../../core/errors/domain-errors.js";
import { StreamsService } from "../../core/redis/streams.service.js";
import { OrchestratorService } from "./orchestrator.service.js";
import { parseThreadId } from "./thread-id.js";

export const RESUME_STREAM = "jobs";
export const RESUME_GROUP = "resumers";
const RESTART_DELAY_MS = 1000;
/** Limite padrão de espera da mensagem em andamento no `stop` (shutdown). */
export const RESUME_STOP_TIMEOUT_MS = 30_000;
/** Token opcional para trocar o limite do `stop` (ms). */
export const RESUME_STOP_TIMEOUT = Symbol("RESUME_STOP_TIMEOUT");

/** Forma de OBJETO no 1º argumento (nestjs-pino): `err` no topo; só ids, nunca payload. */
export interface ResumeLogFields {
  msg: string;
  err?: unknown;
  [field: string]: unknown;
}

export interface ResumeLogger {
  info(fields: ResumeLogFields): void;
  warn(fields: ResumeLogFields): void;
  error(fields: ResumeLogFields): void;
}

export const RESUME_LOGGER = Symbol("RESUME_LOGGER");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPROVAL_ID_RE = /^[0-9a-f]{64}$/;
const MAX_LOG_ID = 256;

/** Id vindo do evento, só para log: cortado (o schema do stream aceita qualquer texto). */
const logId = (value: string) => value.slice(0, MAX_LOG_ID);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type ResumeEvent = Extract<StreamEvent, { type: "resume" }>;

/** Os ids do evento conferem entre si (formato e prefixo do thread). */
function idsMatch(e: ResumeEvent): boolean {
  if (!UUID_RE.test(e.tenantId) || !UUID_RE.test(e.clientId)) return false;
  if (!APPROVAL_ID_RE.test(e.approvalId)) return false;
  const thread = parseThreadId(e.threadId);
  return !!thread && same(thread.tenantId, e.tenantId) && same(thread.clientId, e.clientId);
}

@Injectable()
export class ResumeWorker
  implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown
{
  private abort: AbortController | undefined;
  private loop: Promise<void> | undefined;
  /** Único por instância: dois workers no mesmo processo não dividem o nome no grupo. */
  private readonly consumer = `${hostname()}-${process.pid.toString()}-${randomUUID().slice(0, 8)}`;

  constructor(
    @Inject(ENV) private readonly env: Pick<Env, "WORKERS_ENABLED">,
    @Inject(StreamsService) private readonly streams: Pick<StreamsService, "consume">,
    @Inject(OrchestratorService)
    private readonly orchestrator: Pick<OrchestratorService, "resume" | "finalState">,
    @Inject(RESUME_LOGGER) private readonly logger: ResumeLogger,
    @Optional()
    @Inject(RESUME_STOP_TIMEOUT)
    private readonly stopTimeoutMs: number = RESUME_STOP_TIMEOUT_MS,
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

  /**
   * Para o consumo e espera o loop (e a mensagem em andamento) terminar (idempotente), por no
   * máximo `stopTimeoutMs` (padrão 30 s): um executor travado não trava o shutdown. Estourado o
   * limite, registra o erro e segue; a entrada não confirmada volta pelo XAUTOCLAIM em outra
   * réplica, e a cerca do executeOnce impede execução dupla (`started` vira needs_review no job).
   */
  async stop(): Promise<void> {
    const loop = this.loop;
    if (!loop) return;
    this.abort?.abort();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), this.stopTimeoutMs);
    });
    try {
      const outcome = await Promise.race([loop.then(() => false as const), timedOut]);
      if (outcome) {
        this.logger.error({
          msg: "Worker de retomada não terminou a mensagem em andamento no prazo; encerrando assim mesmo",
        });
      }
    } finally {
      clearTimeout(timer);
      this.loop = undefined;
      this.abort = undefined;
    }
  }

  /** Handler do stream (ver a matriz no cabeçalho): resolve = ACK; rejeita = reentrega. */
  async handle(event: StreamEvent): Promise<void> {
    if (event.type !== "resume") return;
    const ids = {
      eventId: event.eventId,
      tenantId: logId(event.tenantId),
      clientId: logId(event.clientId),
      approvalId: logId(event.approvalId),
      threadId: logId(event.threadId),
    };
    if (!idsMatch(event)) {
      this.logger.error({
        msg: "Evento resume descartado: ids não conferem com o thread (forjado ou corrompido)",
        ...ids,
      });
      return;
    }

    try {
      const status = await TenantContext.run(
        { tenantId: event.tenantId, clientId: event.clientId },
        async () => {
          const state = await this.orchestrator.finalState(event.threadId);
          if (state.pending?.approvalId !== event.approvalId) return null;
          const { execution } = await this.orchestrator.resume(event.threadId, event.approved);
          return execution.status;
        },
      );
      if (status === null) {
        this.logger.warn({
          msg: "Evento resume descartado: o thread não aguarda esta aprovação",
          ...ids,
        });
        return;
      }
      this.logger.info({ msg: "Thread retomado", ...ids, status });
    } catch (err) {
      if (err instanceof NotFoundError) {
        this.logger.warn({ msg: "Evento resume descartado: thread não encontrado", err, ...ids });
        return;
      }
      if (err instanceof ValidationError) {
        this.logger.error({ msg: "Evento resume descartado: retomada inválida", err, ...ids });
        return;
      }
      if (err instanceof ApprovalConflictError) {
        this.logger.warn({
          msg: "Aprovação ainda pendente no banco; o evento resume será reentregue",
          err,
          ...ids,
        });
        throw err;
      }
      this.logger.error({ msg: "Retomada falhou; o evento resume será reentregue", err, ...ids });
      throw err;
    }
  }

  /** `consume` só termina sozinho quando abortado; se falhar (ex.: Redis fora), tenta de novo. */
  private async consumeUntilAborted(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.streams.consume({
          stream: RESUME_STREAM,
          group: RESUME_GROUP,
          consumer: this.consumer,
          handler: (e) => this.handle(e),
          signal,
        });
      } catch (err) {
        if (signal.aborted) break;
        this.logger.error({ msg: "Consumo do stream jobs pela retomada falhou; reiniciando", err });
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
export const resumeLoggerProvider = {
  provide: RESUME_LOGGER,
  useFactory: (): ResumeLogger => {
    // O Logger do Nest não tem `info`: `log` é o nível info (no pino, via nestjs-pino).
    const logger = new Logger(ResumeWorker.name);
    return {
      info: (fields) => logger.log(fields),
      warn: (fields) => logger.warn(fields),
      error: (fields) => logger.error(fields),
    };
  },
};
