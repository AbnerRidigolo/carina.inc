import {
  type ChatEvent,
  ChatEventSchema,
  type ChatRequest,
  ChatRequestSchema,
  WsTicketSchema,
} from "@carina/shared";
import { ApiProblemError, apiFetch, isAbortError } from "./client";

/**
 * Cliente do WebSocket do chat (`/ws/chat`).
 *
 * Protocolo (apps/api/src/modules/chat/chat.gateway.ts): `POST /api/ws/ticket { clientId }` (chave
 * no header, escopo `chat`) devolve um ticket de uso único (30 s); o socket abre em
 * `/ws/chat?ticket=<ticket>` — a chave nunca vai na URL. O servidor fecha com 4401 quando o ticket
 * é inválido, a chave foi revogada ou a conexão passou da vida máxima (30 min).
 *
 * Política de reconexão (sempre com ticket NOVO, nunca reaproveitado):
 *  - queda comum (1006, 1001, 4408...): backoff de 1 s, 2 s e 4 s; depois disso desiste (`offline`);
 *    uma conexão que abre zera a contagem;
 *  - 4401 depois de a conexão ter ficado de pé (>= STABLE_MS): vida máxima vencida, reconecta já;
 *  - 4401 logo depois de abrir: tenta uma vez mais (após 1 s); o segundo 4401 seguido para
 *    (`unauthorized`: chave inválida/revogada) — nada de loop;
 *  - ticket negado com 401/403, ou `error unauthenticated` do servidor: para na hora.
 * Toda mensagem recebida é validada com ChatEventSchema; as inválidas são descartadas.
 */
export type ChatStatus =
  | { state: "connecting" }
  | { state: "open" }
  | { state: "reconnecting"; attempt: number }
  | { state: "offline" }
  | { state: "unauthorized" }
  | { state: "forbidden" }
  | { state: "protocol_error" };

export interface ChatConnection {
  /** Lança se o pedido for inválido ou o socket não estiver aberto. */
  send(request: ChatRequest): void;
  close(): void;
}

export interface ConnectChatOptions {
  clientId: string;
  onEvent: (event: ChatEvent) => void;
  onStatus: (status: ChatStatus) => void;
  signal?: AbortSignal;
  /** Esperas entre tentativas (padrão 1 s, 2 s, 4 s). */
  backoffMs?: readonly number[];
}

export const DEFAULT_BACKOFF_MS = [1000, 2000, 4000] as const;
/** Conexão que ficou de pé tanto tempo foi aceita de verdade: um 4401 depois dela é "vida máxima". */
export const STABLE_MS = 5000;
const OPEN = 1;

function wsUrl(ticket: string): string {
  const { protocol, host } = globalThis.location;
  const url = new URL("/ws/chat", `${protocol === "https:" ? "wss:" : "ws:"}//${host}`);
  url.searchParams.set("ticket", ticket);
  return url.href;
}

/** Abre a conexão; resolve no primeiro `open` e rejeita se desistir antes de conseguir abrir. */
export function connectChat(opts: ConnectChatOptions): Promise<ChatConnection> {
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const ctrl = new AbortController();
  let closed = false;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let quick4401 = 0;
  let openedAt = 0;
  let everOpened = false;
  let settle: { resolve: (c: ChatConnection) => void; reject: (e: Error) => void } | undefined;

  const promise = new Promise<ChatConnection>((resolve, reject) => {
    settle = { resolve, reject };
  });

  const status = (s: ChatStatus) => {
    if (!closed) opts.onStatus(s);
  };

  function dropSocket(): void {
    const s = socket;
    socket = null;
    if (!s) return;
    s.onopen = null;
    s.onmessage = null;
    s.onclose = null;
    s.onerror = null;
    try {
      s.close(1000);
    } catch {
      /* já fechado */
    }
  }

  function finish(): void {
    closed = true;
    clearTimeout(timer);
    timer = undefined;
    ctrl.abort();
    dropSocket();
    opts.signal?.removeEventListener("abort", onAbort);
  }

  /** Para de vez com um estado final (o último status é entregue antes de silenciar). */
  function stop(final: ChatStatus): void {
    opts.onStatus(final);
    finish();
    if (!everOpened) settle?.reject(new Error(`conexão do chat encerrada: ${final.state}`));
  }

  function onAbort(): void {
    finish();
    if (!everOpened) settle?.reject(new Error("conexão do chat cancelada"));
  }

  function schedule(delayMs: number): void {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void attempt();
    }, delayMs);
  }

  /** Falha comum: espera o próximo degrau do backoff ou desiste. */
  function retryAfterFailure(minDelayMs = 0): void {
    failures += 1;
    const step = backoff[failures - 1];
    if (step === undefined) return stop({ state: "offline" });
    status({ state: "reconnecting", attempt: failures });
    schedule(Math.max(step, minDelayMs));
  }

  function handleClose(code: number): void {
    socket = null;
    if (closed) return;
    if (code === 4401) {
      const stable = openedAt > 0 && Date.now() - openedAt >= STABLE_MS;
      if (stable) {
        quick4401 = 0;
        status({ state: "reconnecting", attempt: 0 });
        return schedule(0);
      }
      quick4401 += 1;
      if (quick4401 >= 2) return stop({ state: "unauthorized" });
      status({ state: "reconnecting", attempt: 1 });
      return schedule(backoff[0] ?? 1000);
    }
    retryAfterFailure();
  }

  function handleMessage(data: unknown): void {
    if (closed) return;
    let json: unknown;
    try {
      json = typeof data === "string" ? JSON.parse(data) : undefined;
    } catch {
      json = undefined;
    }
    const parsed = ChatEventSchema.safeParse(json);
    if (!parsed.success) return status({ state: "protocol_error" });
    opts.onEvent(parsed.data);
    if (parsed.data.type === "error" && parsed.data.code === "unauthenticated") {
      stop({ state: "unauthorized" });
    }
  }

  async function attempt(): Promise<void> {
    if (closed) return;
    if (!everOpened && failures === 0) status({ state: "connecting" });
    let ticket: string;
    try {
      ({ ticket } = await apiFetch("/api/ws/ticket", WsTicketSchema, {
        method: "POST",
        body: { clientId: opts.clientId },
        signal: ctrl.signal,
      }));
    } catch (err) {
      if (closed || isAbortError(err)) return;
      if (err instanceof ApiProblemError && err.status === 401)
        return stop({ state: "unauthorized" });
      if (err instanceof ApiProblemError && err.status === 403) return stop({ state: "forbidden" });
      const retryAfter = err instanceof ApiProblemError ? err.retryAfterSeconds : undefined;
      return retryAfterFailure(retryAfter !== undefined ? Math.min(retryAfter, 30) * 1000 : 0);
    }
    if (closed) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(ticket));
    } catch {
      return retryAfterFailure();
    }
    socket = ws;
    ws.onopen = () => {
      if (closed || socket !== ws) return;
      openedAt = Date.now();
      failures = 0;
      status({ state: "open" });
      if (!everOpened) {
        everOpened = true;
        settle?.resolve(connection);
      }
    };
    ws.onmessage = (ev) => handleMessage(ev.data);
    ws.onclose = (ev) => {
      if (socket !== ws) return;
      handleClose(ev.code);
    };
    ws.onerror = () => {
      // O `close` que sempre vem depois decide o que fazer.
    };
  }

  const connection: ChatConnection = {
    send(request) {
      const parsed = ChatRequestSchema.parse(request);
      if (closed || !socket || socket.readyState !== OPEN) {
        throw new Error("Não conectado ao servidor");
      }
      socket.send(JSON.stringify(parsed));
    },
    close() {
      if (closed) return;
      finish();
      if (!everOpened) settle?.reject(new Error("conexão do chat cancelada"));
    },
  };

  if (opts.signal?.aborted) {
    onAbort();
  } else {
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    void attempt();
  }
  return promise;
}
