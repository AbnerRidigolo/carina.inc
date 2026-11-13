/**
 * WebSocket do chat (`/ws/chat`, `@nestjs/platform-ws`, mesmo servidor HTTP).
 *
 * Protocolo:
 *  - Conexão: `/ws/chat?ticket=<ticket>`; o ticket vem de `POST /api/ws/ticket` (chave com escopo
 *    `chat`) e vale uma vez, por 30 s. Sem ticket válido (ausente, malformado, vencido ou já usado)
 *    a conexão fecha com 4401 sem receber nenhum dado. A conexão fica presa, pela vida toda, ao
 *    tenant, à chave e ao cliente final do ticket: nada na mensagem troca isso.
 *  - Cliente → servidor: texto JSON, exatamente um `ChatRequest` (`{ clientId, message, threadId? }`,
 *    sem campos extras), com `clientId` igual ao do ticket. Até `WS_MAX_PAYLOAD_BYTES` por frame
 *    (acima disso o `ws` fecha com 1009). Mensagens mandadas logo após o `open`, antes de o ticket
 *    ser conferido, esperam a conferência (não se perdem).
 *  - Servidor → cliente: cada `ChatEvent` como JSON. Por mensagem: os eventos do turno até `done`
 *    ou `error { code, traceId }` (códigos de domínio, ou `validation_error`, `client_mismatch`,
 *    `turn_in_progress`, `rate_limited`, `internal_error`; nunca texto interno). A qualquer momento:
 *    `approval_required` / `approval_executed` do próprio tenant e cliente (InboxBroadcast), sem
 *    repetir um `approval_required` já enviado nesta conexão.
 *  - Um turno por conexão de cada vez (outra mensagem no meio → `turn_in_progress`); a serialização
 *    por thread entre conexões e réplicas é o lock do ChatService.
 *  - Limite por minuto do tenant por mensagem (a mesma janela `rl:<tenantId>` do RateLimitGuard do
 *    REST) e cota mensal (ChatService).
 *  - Heartbeat: ping a cada `pingIntervalMs`; sem pong até o próximo, `terminate()`. Ociosa (sem
 *    mensagem do cliente e sem turno em andamento) por `idleTimeoutMs` → fecha com 4408.
 *  - Desconexão no meio do turno: cancelamento (o turno termina em segundo plano; ver ChatService).
 *  - Shutdown: fecha cada socket com 1001 e cancela a entrega dos turnos em andamento.
 *
 * Origem (`Origin`): não é conferida. A autenticação é o ticket, que só sai de uma chamada REST
 * autenticada pela chave (um site de terceiros não consegue um ticket sem a chave). Logs: só ids;
 * a URL (com o ticket) nunca é registrada.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { ChatRequestSchema, type ChatEvent } from "@carina/shared";
import { Inject, Logger, type OnModuleDestroy, type OnModuleInit, Optional } from "@nestjs/common";
import { type OnGatewayConnection, WebSocketGateway } from "@nestjs/websockets";
import type { Redis } from "ioredis";
import WebSocket, { type RawData } from "ws";
import { REDIS } from "../../core/redis/redis.tokens.js";
import { CLOCK, type Clock } from "../limits/clock.js";
import { RATE_LIMIT_WINDOW_MS } from "../limits/rate-limit.guard.js";
import { slidingWindowAcquire } from "../limits/sliding-window.lua.js";
import { CHAT_LOGGER, type ChatLogger, ChatService } from "./chat.service.js";
import { InboxBroadcast } from "./inbox-broadcast.js";
import { type WsTicketGrant, WsTicketService } from "./ws-ticket.service.js";

export const WS_CHAT_PATH = "/ws/chat";
/** 8.000 caracteres de até 4 bytes cabem com folga; o resto é abuso. */
export const WS_MAX_PAYLOAD_BYTES = 64 * 1024;

export const WS_CLOSE_UNAUTHORIZED = 4401;
export const WS_CLOSE_IDLE = 4408;
export const WS_CLOSE_SHUTDOWN = 1001;

export const CHAT_GATEWAY_OPTIONS = Symbol("CHAT_GATEWAY_OPTIONS");

export interface ChatGatewayOptions {
  pingIntervalMs?: number;
  idleTimeoutMs?: number;
}

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const SHUTDOWN_CLOSE_WAIT_MS = 2000;
/** Quantos ids de aprovação já enviados a conexão lembra (para não repetir `approval_required`). */
const SENT_APPROVALS_MAX = 256;

/** Mensagem do cliente: um ChatRequest, sem campos extras (tipos desconhecidos são recusados). */
const WsChatMessageSchema = ChatRequestSchema.strict();

function ticketOf(req: IncomingMessage | undefined): string | undefined {
  try {
    return new URL(req?.url ?? "", "ws://localhost").searchParams.get("ticket") ?? undefined;
  } catch {
    return undefined;
  }
}

function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
}

interface ConnectionDeps {
  chat: Pick<ChatService, "run">;
  tickets: Pick<WsTicketService, "consume">;
  broadcast: Pick<InboxBroadcast, "subscribe">;
  redis: Pick<Redis, "eval">;
  clock: Clock;
  logger: ChatLogger;
}

/** Estado de uma conexão autenticada (ou em autenticação). */
class ChatConnection {
  private ready: Promise<WsTicketGrant | null> = Promise.resolve(null);
  private busy = false;
  private alive = true;
  private lastActivity: number;
  private readonly abort = new AbortController();
  private unsubscribe: (() => void) | undefined;
  private readonly sentApprovals = new Set<string>();

  constructor(
    readonly socket: WebSocket,
    private readonly deps: ConnectionDeps,
  ) {
    this.lastActivity = deps.clock();
  }

  start(ticket: string | undefined): void {
    // Listeners antes de qualquer await: nenhuma mensagem do cliente se perde.
    this.socket.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    this.socket.on("pong", () => {
      this.alive = true;
    });
    this.ready = this.deps.tickets
      .consume(ticket)
      .catch((err: unknown) => {
        this.deps.logger.error({ msg: "Falha ao conferir o ticket de WebSocket", err });
        return null;
      })
      .then((grant) => {
        if (this.socket.readyState !== WebSocket.OPEN) return null;
        if (!grant) {
          this.socket.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
          return null;
        }
        this.unsubscribe = this.deps.broadcast.subscribe({
          tenantId: grant.tenant.tenantId,
          clientId: grant.client.id,
          clientExternalId: grant.client.externalId,
          send: (event) => this.send(event),
        });
        return grant;
      });
  }

  /** Heartbeat e ociosidade (chamado pelo timer do gateway). */
  tick(now: number, idleTimeoutMs: number): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    if (!this.alive) {
      this.socket.terminate();
      return;
    }
    this.alive = false;
    this.socket.ping();
    if (!this.busy && now - this.lastActivity >= idleTimeoutMs) {
      this.socket.close(WS_CLOSE_IDLE, "idle");
    }
  }

  /** Socket fechou: para de entregar (o turno em andamento termina em segundo plano). */
  dispose(): void {
    this.abort.abort();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  shutdown(): void {
    this.dispose();
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close(WS_CLOSE_SHUTDOWN, "server shutdown");
    }
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    this.lastActivity = this.deps.clock();
    void this.ready
      .then((grant) => (grant ? this.handle(grant, data, isBinary) : undefined))
      .catch((err: unknown) => {
        this.deps.logger.error({ msg: "Falha ao tratar mensagem do WebSocket", err });
      });
  }

  private async handle(grant: WsTicketGrant, data: RawData, isBinary: boolean): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    const traceId = randomUUID();
    if (isBinary) return this.sendError("validation_error", traceId);
    let json: unknown;
    try {
      json = JSON.parse(textOf(data));
    } catch {
      return this.sendError("validation_error", traceId);
    }
    const parsed = WsChatMessageSchema.safeParse(json);
    if (!parsed.success) return this.sendError("validation_error", traceId);
    if (parsed.data.clientId !== grant.client.externalId) {
      return this.sendError("client_mismatch", traceId);
    }
    // Checado e marcado sem await no meio: duas mensagens nunca passam juntas.
    if (this.busy) return this.sendError("turn_in_progress", traceId);
    this.busy = true;
    try {
      const { tenant } = grant;
      const { allowed } = await slidingWindowAcquire(
        this.deps.redis,
        `rl:${tenant.tenantId}`,
        tenant.rpm,
        RATE_LIMIT_WINDOW_MS,
        this.deps.clock(),
      );
      if (!allowed) return this.sendError("rate_limited", traceId);
      for await (const event of this.deps.chat.run(tenant, parsed.data, "ws", {
        traceId,
        signal: this.abort.signal,
      })) {
        this.send(event);
      }
    } finally {
      this.busy = false;
      this.lastActivity = this.deps.clock();
    }
  }

  private sendError(code: string, traceId: string): void {
    this.send({ type: "error", code, traceId });
  }

  private send(event: ChatEvent): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    if (event.type === "approval_required") {
      if (this.sentApprovals.has(event.approval.id)) return;
      if (this.sentApprovals.size >= SENT_APPROVALS_MAX) this.sentApprovals.clear();
      this.sentApprovals.add(event.approval.id);
    }
    this.socket.send(JSON.stringify(event));
  }
}

@WebSocketGateway({ path: WS_CHAT_PATH, maxPayload: WS_MAX_PAYLOAD_BYTES })
export class ChatGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  private readonly connections = new Set<ChatConnection>();
  private readonly pingIntervalMs: number;
  private readonly idleTimeoutMs: number;
  private timer: NodeJS.Timeout | undefined;
  private readonly deps: ConnectionDeps;

  constructor(
    @Inject(ChatService) chat: ChatService,
    @Inject(WsTicketService) tickets: WsTicketService,
    @Inject(InboxBroadcast) broadcast: InboxBroadcast,
    @Inject(REDIS) redis: Redis,
    @Inject(CLOCK) clock: Clock,
    @Optional() @Inject(CHAT_GATEWAY_OPTIONS) opts: ChatGatewayOptions | null = null,
    @Optional()
    @Inject(CHAT_LOGGER)
    logger: ChatLogger = new Logger(ChatGateway.name),
  ) {
    this.pingIntervalMs = opts?.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.deps = { chat, tickets, broadcast, redis, clock, logger };
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      const now = this.deps.clock();
      for (const c of this.connections) c.tick(now, this.idleTimeoutMs);
    }, this.pingIntervalMs);
    this.timer.unref();
  }

  handleConnection(socket: WebSocket, req?: IncomingMessage): void {
    const connection = new ChatConnection(socket, this.deps);
    this.connections.add(connection);
    socket.once("close", () => {
      this.connections.delete(connection);
      connection.dispose();
    });
    connection.start(ticketOf(req));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const closing = [...this.connections].map(
      (c) =>
        new Promise<void>((resolve) => {
          if (c.socket.readyState === WebSocket.CLOSED) return resolve();
          c.socket.once("close", () => resolve());
          c.shutdown();
        }),
    );
    if (closing.length === 0) return;
    // Espera o handshake de close (o adaptador derruba o que sobrar ao fechar o servidor).
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(closing),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_CLOSE_WAIT_MS);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
  }
}
