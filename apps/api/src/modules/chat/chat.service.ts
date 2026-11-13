/**
 * Um turno de chat (spec §6.1), comum ao REST e ao WebSocket.
 *
 * Ordem (cada passo só roda se o anterior passou):
 *  1. valida o `ChatRequest` → `ValidationError` ANTES de reservar a cota;
 *  2. reserva 1 unidade da cota (`QuotaService.reserve`);
 *  3. resolve o cliente final (`create: true`);
 *  4. monta o `threadId`: o recebido precisa ser `${tenantId}:${clientUuid}:<id>` (senão
 *     `NotFoundError`, sem dizer se o thread existe em outro lugar); sem `threadId`, gera um novo;
 *  5. trava o thread (`LockService`, chave `chat:thread:<threadId>`): dois turnos do mesmo thread
 *     nunca rodam em paralelo; quem chega com o lock ocupado recebe `ThreadBusyError` (409) na hora
 *     (não espera). Isso fecha o check-then-act do guard de aprovação do orquestrador;
 *  6. repassa os eventos do orquestrador, que roda sob `TenantContext.withClient(clientUuid)`;
 *  7. no fim, numa `tx`: `usage_record` (`classifyWork(plan.agents)`) e `audit_event`
 *     (`WatchtowerService.review` sobre a resposta inteira já montada: `answer` + resultados
 *     serializados; o streaming de tokens NÃO é revisado pedaço a pedaço);
 *  8. libera o lock e emite `done` (`awaiting_approval` só se a aprovação do turno está `pending` e
 *     não vencida NO BANCO; o checkpoint pode dizer "esperando" de uma aprovação já resolvida).
 * Qualquer erro antes do `done`: libera o lock, devolve a cota e não cobra nada (nem audita).
 *
 * Turno sem resposta: o grafo absorve falhas de LLM (heurística no classificador, `agentFailure` nos
 * especialistas, resposta fixa no Navigator). Se o Navigator falhou (`errors.navigator`), o turno não
 * tem resposta e vira `AllProvidersFailedError` (503 / `error`), salvo se o turno já deixou uma
 * aprovação pendente (efeito durável que o cliente precisa ver).
 *
 * ── Cancelamento (cliente HTTP sumiu, WebSocket fechou) ──────────────────────────────────────
 * O turno roda num "pump" desacoplado de quem consome os eventos. Se o consumidor desiste (`signal`
 * abortado ou o iterador encerrado), o pump NÃO é interrompido: o grafo termina em segundo plano,
 * os eventos restantes são descartados e o fim é o mesmo de um turno normal (cobrança e auditoria se
 * concluiu, devolução da cota se falhou, lock liberado no fim). Motivo: cancelar o grafo no meio de
 * um nó deixa estado inconsistente (ex.: o executor grava a `approval_request` e o cancelamento chega
 * antes do `pending` ir para o checkpoint → aprovação órfã). Cancelamento não é falha de provedor:
 * não devolve a cota de um turno que concluiu e é registrado como `info`, não como erro. O turno
 * concluído é cobrado porque a resposta foi gerada e gravada no histórico do thread.
 * No shutdown, `onModuleDestroy` espera os turnos em segundo plano (com prazo).
 *
 * Logs: só ids e códigos (`{ msg, err?, tenantId, threadId, traceId }`); nunca a pergunta, a
 * resposta ou o payload.
 */
import { randomUUID } from "node:crypto";
import {
  type ApprovalView,
  type ChatEvent,
  type ChatRequest,
  ChatRequestSchema,
  type ChatResponse,
  type ChatTurnStatus,
  type Plan,
} from "@carina/shared";
import { Inject, Injectable, Logger, type OnModuleDestroy, Optional } from "@nestjs/common";
import { TenantContext } from "../../core/context/tenant-context.js";
import { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import {
  AllProvidersFailedError,
  DomainError,
  NotFoundError,
  ThreadBusyError,
  ValidationError,
} from "../../core/errors/domain-errors.js";
import { type LockHandle, LockService } from "../../core/redis/lock.service.js";
import { BillingService } from "../billing/billing.service.js";
import { classifyWork } from "../billing/pricing.js";
import { InboxService } from "../inbox/inbox.service.js";
import { CLOCK, type Clock } from "../limits/clock.js";
import { QuotaService } from "../limits/quota.service.js";
import { OrchestratorService } from "../orchestrator/orchestrator.service.js";
import type { AuthTenant } from "../tenancy/api-key.guard.js";
import { ClientsService } from "../tenancy/clients.service.js";
import { WatchtowerService } from "../watchtower/watchtower.service.js";

export type ChatChannel = "rest" | "ws";

/** TTL do lock do thread (renovado pelo heartbeat a cada ttl/3 enquanto o turno roda). */
export const THREAD_LOCK_TTL_MS = 120_000;
/** Quanto o shutdown espera os turnos em segundo plano. */
export const SHUTDOWN_DRAIN_MS = 10_000;

export const threadLockKey = (threadId: string): string => `chat:thread:${threadId}`;

const THREAD_SUFFIX_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const CHAT_LOGGER = Symbol("CHAT_LOGGER");

/** Forma de OBJETO no 1º argumento (nestjs-pino): `err` no topo; só ids. */
export interface ChatLogger {
  log(fields: { msg: string; [k: string]: unknown }): void;
  warn(fields: { msg: string; err?: unknown; [k: string]: unknown }): void;
  error(fields: { msg: string; err?: unknown; [k: string]: unknown }): void;
}

export interface ChatRunOptions {
  /** Id de correlação (o do request HTTP; no WS, um por mensagem); vai no evento `error`. */
  traceId?: string;
  /** O consumidor desistiu (ver "Cancelamento" no topo): para de entregar eventos. */
  signal?: AbortSignal;
}

/** Código público do erro: o `code` do erro de domínio, ou `internal_error`. Nunca a mensagem. */
export function publicErrorCode(err: unknown): string {
  return err instanceof DomainError ? err.code : "internal_error";
}

/** Valida o pedido; o erro cita só caminhos e regras do schema, nunca o texto recebido. */
export function parseChatRequest(input: unknown): ChatRequest {
  const parsed = ChatRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`).join("; "),
    );
  }
  return parsed.data;
}

/** `threadId` do turno, sempre no espaço do tenant e do cliente da requisição. */
export function threadIdFor(tenantId: string, clientUuid: string, requested?: string): string {
  const prefix = `${tenantId}:${clientUuid}:`;
  if (requested === undefined) return `${prefix}${randomUUID()}`;
  if (!requested.startsWith(prefix) || !THREAD_SUFFIX_RE.test(requested.slice(prefix.length))) {
    throw new NotFoundError("Thread não encontrado");
  }
  return requested;
}

/**
 * Fila entre o pump (produtor) e quem consome os eventos. Depois de `detach()` (consumidor foi
 * embora) os eventos são descartados; o pump segue até o fim.
 */
class TurnQueue {
  private readonly buffer: ChatEvent[] = [];
  private wake: (() => void) | undefined;
  private failure: { err: unknown } | undefined;
  private detached = false;
  finished = false;
  summary: ChatResponse | undefined;

  push(event: ChatEvent): void {
    if (this.detached || this.finished) return;
    this.buffer.push(event);
    this.notify();
  }

  end(): void {
    this.finished = true;
    this.notify();
  }

  fail(err: unknown): void {
    this.failure = { err };
    this.finished = true;
    this.notify();
  }

  detach(): void {
    this.detached = true;
    this.buffer.length = 0;
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  /** Entrega em ordem; termina no fim do turno (ou lança o erro dele) ou quando `signal` aborta. */
  async *drain(signal?: AbortSignal): AsyncGenerator<ChatEvent> {
    for (;;) {
      if (signal?.aborted) return;
      const next = this.buffer.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.finished) {
        if (this.failure) throw this.failure.err;
        return;
      }
      await new Promise<void>((resolve) => {
        const onAbort = () => resolve();
        this.wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}

interface TurnAccumulator {
  plan: Plan | undefined;
  results: Record<string, unknown>;
  answer: string | undefined;
  approvalId: string | undefined;
}

@Injectable()
export class ChatService implements OnModuleDestroy {
  private readonly background = new Set<Promise<void>>();

  constructor(
    @Inject(QuotaService) private readonly quota: Pick<QuotaService, "reserve" | "refund">,
    @Inject(ClientsService) private readonly clients: Pick<ClientsService, "resolve">,
    @Inject(OrchestratorService)
    private readonly orchestrator: Pick<OrchestratorService, "stream" | "finalState">,
    @Inject(BillingService) private readonly billing: Pick<BillingService, "record">,
    @Inject(WatchtowerService) private readonly watchtower: Pick<WatchtowerService, "review">,
    @Inject(TenantPrismaService) private readonly db: Pick<TenantPrismaService, "tx">,
    @Inject(LockService) private readonly locks: Pick<LockService, "acquire">,
    @Inject(InboxService) private readonly inbox: Pick<InboxService, "get">,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional()
    @Inject(CHAT_LOGGER)
    private readonly logger: ChatLogger = new Logger(ChatService.name),
  ) {}

  /**
   * Eventos do turno; qualquer falha vira o evento final `error { code, traceId }` (sem mensagem
   * interna). Usado pelo WebSocket.
   */
  async *run(
    tenant: AuthTenant,
    req: unknown,
    channel: ChatChannel,
    opts: ChatRunOptions = {},
  ): AsyncIterable<ChatEvent> {
    const traceId = opts.traceId ?? randomUUID();
    try {
      yield* this.execute(tenant, req, channel, { ...opts, traceId });
    } catch (err) {
      yield { type: "error", code: publicErrorCode(err), traceId };
    }
  }

  /** Como `run`, mas a falha é LANÇADA (erro de domínio intacto, para o filtro RFC 9457). */
  async *execute(
    tenant: AuthTenant,
    req: unknown,
    channel: ChatChannel,
    opts: ChatRunOptions = {},
  ): AsyncGenerator<ChatEvent> {
    const queue = this.start(tenant, req, channel, opts.traceId);
    try {
      yield* queue.drain(opts.signal);
    } finally {
      this.detachIfRunning(queue, tenant, opts.traceId);
    }
  }

  /**
   * `POST /api/chat`: consome o turno e devolve o resultado consolidado. `undefined` se o
   * consumidor desistiu antes do fim (o turno termina em segundo plano).
   */
  async chat(
    tenant: AuthTenant,
    req: unknown,
    channel: ChatChannel,
    opts: ChatRunOptions = {},
  ): Promise<ChatResponse | undefined> {
    const queue = this.start(tenant, req, channel, opts.traceId);
    try {
      for await (const event of queue.drain(opts.signal)) void event;
    } finally {
      this.detachIfRunning(queue, tenant, opts.traceId);
    }
    return queue.summary;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.background.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), SHUTDOWN_DRAIN_MS);
      timer.unref();
    });
    const outcome = await Promise.race([
      Promise.allSettled([...this.background]).then(() => "drained" as const),
      deadline,
    ]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      this.logger.warn({
        msg: "Shutdown com turnos de chat ainda em andamento",
        pending: this.background.size,
      });
    }
  }

  /** Valida (lança antes de reservar a cota) e dispara o pump do turno. */
  private start(
    tenant: AuthTenant,
    input: unknown,
    channel: ChatChannel,
    traceId: string | undefined,
  ): TurnQueue {
    const req = parseChatRequest(input);
    const queue = new TurnQueue();
    const job = this.pump(tenant, req, channel, queue, traceId).catch((err: unknown) => {
      // O pump trata os próprios erros; chegar aqui é defeito. A fila não pode ficar pendurada.
      this.logger.error({ msg: "Falha inesperada no turno de chat", err, traceId });
      queue.fail(err);
    });
    this.background.add(job);
    void job.finally(() => this.background.delete(job));
    return queue;
  }

  private detachIfRunning(queue: TurnQueue, tenant: AuthTenant, traceId?: string): void {
    if (queue.finished) return;
    queue.detach();
    this.logger.log({
      msg: "Turno de chat cancelado pelo cliente; o grafo termina em segundo plano",
      tenantId: tenant.tenantId,
      traceId,
    });
  }

  private async pump(
    tenant: AuthTenant,
    req: ChatRequest,
    channel: ChatChannel,
    queue: TurnQueue,
    traceId: string | undefined,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.quota.reserve(tenant);
    } catch (err) {
      queue.fail(err); // nada reservado, nada a devolver
      return;
    }

    const held: { lock?: LockHandle; threadId?: string } = {};
    try {
      const summary = await TenantContext.run(
        { tenantId: tenant.tenantId, keyId: tenant.keyId, scopes: tenant.scopes },
        async () => {
          const client = await this.clients.resolve(req.clientId, { create: true });
          const threadId = threadIdFor(tenant.tenantId, client.id, req.threadId);
          held.threadId = threadId;
          const lock = await this.locks.acquire(threadLockKey(threadId), THREAD_LOCK_TTL_MS);
          if (!lock) throw new ThreadBusyError("Outro turno está em andamento neste thread");
          held.lock = lock;
          return TenantContext.withClient(client.id, () =>
            this.turn(req, channel, client.id, threadId, queue, startedAt),
          );
        },
      );
      // Lock liberado ANTES do `done`: quem recebe o `done` já pode mandar o próximo turno.
      await this.release(held.lock, held.threadId);
      queue.summary = summary;
      queue.push(this.doneEvent(summary));
      queue.end();
    } catch (err) {
      await this.release(held.lock, held.threadId);
      try {
        await this.quota.refund(tenant);
      } catch (refundErr) {
        this.logger.error({
          msg: "Falha ao devolver a cota do turno com erro",
          err: refundErr,
          tenantId: tenant.tenantId,
          traceId,
        });
      }
      this.logFailure(err, tenant.tenantId, held.threadId, traceId);
      queue.fail(err);
    }
  }

  /** Roda sob o contexto do tenant E do cliente. */
  private async turn(
    req: ChatRequest,
    channel: ChatChannel,
    clientUuid: string,
    threadId: string,
    queue: TurnQueue,
    startedAt: number,
  ): Promise<ChatResponse> {
    const acc: TurnAccumulator = {
      plan: undefined,
      results: {},
      answer: undefined,
      approvalId: undefined,
    };
    for await (const event of this.orchestrator.stream({ threadId, question: req.message })) {
      if (event.type === "plan") acc.plan = event.plan;
      else if (event.type === "agent_result") {
        if (event.agent === "navigator") {
          acc.answer = typeof event.result === "string" ? event.result : undefined;
        } else acc.results[event.agent] = event.result;
      } else if (event.type === "approval_required") acc.approvalId = event.approval.id;
      queue.push(event);
    }

    const state = await this.orchestrator.finalState(threadId);
    // `pending` e `errors` são do turno (o classify zera os campos do turno).
    const approvalId = acc.approvalId ?? state.pending?.approvalId ?? undefined;
    if (state.errors["navigator"] !== undefined && approvalId === undefined) {
      throw new AllProvidersFailedError();
    }
    const plan = acc.plan ?? state.plan;
    if (!plan) throw new Error("Turno do orquestrador terminou sem plano");
    const answer = acc.answer ?? state.answer ?? "";

    let approval: ApprovalView | undefined;
    let status: ChatTurnStatus = "completed";
    if (approvalId !== undefined) {
      approval = await this.inbox.get(approvalId);
      if (approval.status === "pending" && Date.parse(approval.expiresAt) > this.clock()) {
        status = "awaiting_approval";
      }
    }

    const durationMs = Date.now() - startedAt;
    const workType = classifyWork(plan.agents);
    const responseText = `${answer}\n${JSON.stringify(acc.results)}`;
    const { usage, compliance } = await this.db.tx(async (tx) => {
      const record = await this.billing.record({
        tx,
        clientId: clientUuid,
        workType,
        agents: plan.agents,
        durationMs,
      });
      const review = await this.watchtower.review({
        tx,
        clientId: clientUuid,
        channel,
        query: req.message,
        agents: plan.agents,
        responseText,
        durationMs,
      });
      return {
        usage: { workType, priceBrl: record.priceBrl.toFixed(2) },
        compliance: { auditId: review.auditId, flags: review.flags },
      };
    });

    return {
      threadId,
      status,
      plan,
      results: acc.results,
      answer,
      ...(approval ? { approval } : {}),
      usage,
      compliance,
    };
  }

  private doneEvent(s: ChatResponse): ChatEvent {
    return {
      type: "done",
      threadId: s.threadId,
      status: s.status,
      answer: s.answer,
      usage: s.usage,
      compliance: s.compliance,
    };
  }

  private async release(lock: LockHandle | undefined, threadId: string | undefined): Promise<void> {
    if (!lock) return;
    try {
      await lock.release();
    } catch (err) {
      // O TTL expira sozinho; o próximo turno do thread espera no máximo THREAD_LOCK_TTL_MS.
      this.logger.warn({ msg: "Falha ao liberar o lock do thread", err, threadId });
    }
  }

  private logFailure(
    err: unknown,
    tenantId: string,
    threadId: string | undefined,
    traceId: string | undefined,
  ): void {
    if (err instanceof DomainError && err.status < 500) return; // erro do cliente: o filtro responde
    if (err instanceof DomainError) {
      this.logger.warn({
        msg: "Turno de chat falhou",
        code: err.code,
        tenantId,
        threadId,
        traceId,
      });
      return;
    }
    this.logger.error({ msg: "Turno de chat falhou", err, tenantId, threadId, traceId });
  }
}
