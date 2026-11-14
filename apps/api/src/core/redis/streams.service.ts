import { StreamEventSchema, type StreamEvent } from "@carina/shared";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { Redis } from "ioredis";
import { ValidationError } from "../errors/domain-errors.js";
import { REDIS } from "./redis.tokens.js";

export type StreamName = "inbox.events" | "notifications" | "jobs";

export const STREAMS_OPTIONS = Symbol("STREAMS_OPTIONS");

/**
 * Registros no formato objeto do pino, `{ msg, err, stream, ... }`, com o Error em `err` no topo:
 * pelo Logger do Nest apontado para o nestjs-pino, o serializador grava `err.message` e
 * `err.stack` (R14). Nunca texto de erro concatenado na mensagem.
 */
export interface StreamsLogger {
  error(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
}

export interface StreamsOptions {
  /** Tempo ocioso (ms) após o qual uma pendente é reivindicada por XAUTOCLAIM. */
  claimIdleMs?: number;
  /** Entregas após as quais o evento vai para a DLQ. */
  maxDeliveries?: number;
  /** Duração do BLOCK das leituras (ms). */
  blockMs?: number;
  /** Duração do BLOCK do tail (ms); por padrão, a mesma de `blockMs`. */
  tailBlockMs?: number;
  logger?: StreamsLogger;
}

export interface ConsumeOptions {
  stream: StreamName;
  group: string;
  consumer: string;
  handler: (e: StreamEvent) => Promise<void>;
  signal: AbortSignal;
}

type RawEntry = [id: string, fields: string[] | null];
type ReadReply = [stream: string, entries: RawEntry[]][] | null;

const DEDUP_TTL_SECONDS = 86_400;
const BATCH = 10;
/** Espera entre tentativas após erro de leitura do tail: dobra a cada falha, com teto. */
const TAIL_BACKOFF_MIN_MS = 200;
const TAIL_BACKOFF_MAX_MS = 1000;

function fieldOf(fields: string[] | null, name: string): string | undefined {
  if (!fields) return undefined;
  const i = fields.indexOf(name);
  return i >= 0 ? fields[i + 1] : undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@Injectable()
export class StreamsService {
  private readonly claimIdleMs: number;
  private readonly maxDeliveries: number;
  private readonly blockMs: number;
  private readonly tailBlockMs: number;
  private readonly logger: StreamsLogger;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Optional() @Inject(STREAMS_OPTIONS) opts: StreamsOptions = {},
  ) {
    this.claimIdleMs = opts.claimIdleMs ?? 60_000;
    this.maxDeliveries = opts.maxDeliveries ?? 5;
    this.blockMs = opts.blockMs ?? 5000;
    this.tailBlockMs = opts.tailBlockMs ?? this.blockMs;
    this.logger = opts.logger ?? new Logger(StreamsService.name);
  }

  async publish(stream: StreamName, event: StreamEvent): Promise<string> {
    const parsed = StreamEventSchema.safeParse(event);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new ValidationError(`Evento inválido para ${stream}: ${issues}`);
    }
    const id = await this.redis.xadd(stream, "*", "data", JSON.stringify(parsed.data));
    if (id === null) throw new Error(`XADD em ${stream} não devolveu id`);
    return id;
  }

  async consume(opts: ConsumeOptions): Promise<void> {
    const { stream, group, consumer, signal } = opts;
    if (signal.aborted) return;
    try {
      await this.redis.xgroup("CREATE", stream, group, "0", "MKSTREAM");
    } catch (err) {
      if (!errMessage(err).includes("BUSYGROUP")) throw err;
    }

    // Conexão própria para o BLOCK: uma conexão bloqueada não atende outros comandos.
    const blocking = this.redis.duplicate();
    blocking.on("error", () => undefined);
    const onAbort = () => blocking.disconnect();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (!signal.aborted) {
        await this.reclaim(opts);
        if (signal.aborted) break;
        let reply: ReadReply;
        try {
          reply = (await blocking.xreadgroup(
            "GROUP",
            group,
            consumer,
            "COUNT",
            BATCH,
            "BLOCK",
            this.blockMs,
            "STREAMS",
            stream,
            ">",
          )) as ReadReply;
        } catch (err) {
          if (signal.aborted) break;
          this.logger.error({ msg: "XREADGROUP falhou; nova tentativa", err, stream, group });
          await this.sleep(500, signal);
          continue;
        }
        for (const [, entries] of reply ?? []) {
          for (const [id, fields] of entries) {
            if (signal.aborted) break;
            await this.safely(stream, id, () => this.processEntry(opts, id, fields, 1));
          }
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      blocking.disconnect();
    }
  }

  /**
   * Leitor de broadcast (sem grupo): entrega a `onEvent`, em ordem e uma única vez, as entradas de
   * `stream` publicadas depois do início do tail. Não reenvia o histórico.
   *
   * Cursor: o id inicial é resolvido UMA vez (`XREVRANGE + - COUNT 1`; `0-0` se o stream estiver
   * vazio ou não existir) e passa a ser o id da última entrada recebida. Nunca se usa `$`, que
   * significa "mais novo que o instante da chamada" e perde o que for publicado entre dois XREAD
   * (após um BLOCK vazio, após um erro, ou entre o início do tail e o primeiro XREAD).
   *
   * Garantia para um evento publicado junto com o início: o XREVRANGE sai pela conexão principal
   * de forma síncrona na chamada de `tail()`, antes de qualquer await. Logo:
   *  - todo evento cujo XADD o servidor aplicou DEPOIS desse XREVRANGE tem id maior que o cursor
   *    e é entregue (inclusive o publicado, pela mesma conexão `redis`, após `tail()` ser chamado);
   *  - todo evento aplicado ANTES dele (id <= cursor) conta como histórico e não é entregue;
   *  - não há terceira possibilidade: nenhum evento some depois de o cursor ser fixado.
   * Se a resolução do id inicial falhar, ela é repetida (com espera) e a garantia passa a valer
   * a partir da tentativa que der certo: o que foi publicado durante a falha conta como histórico.
   *
   * Erro de leitura: espera 200 ms (dobra até 1 s) e repete do MESMO cursor; um XREAD reenviado
   * após reconexão carrega o mesmo id, então tampouco repete nem pula entradas.
   */
  async tail(
    stream: StreamName,
    onEvent: (e: StreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    // Emitido de forma síncrona (antes de qualquer await), pela conexão principal: fica ordenado
    // antes de qualquer XADD que o chamador faça por ela logo após chamar tail().
    let pendingStart: Promise<string> | null = this.latestId(stream);
    pendingStart.catch(() => undefined); // rejeição tratada no loop; nunca "unhandled"

    const blocking = this.redis.duplicate();
    blocking.on("error", () => undefined);
    const onAbort = () => blocking.disconnect();
    signal.addEventListener("abort", onAbort, { once: true });
    let cursor: string | null = null;
    let backoff = TAIL_BACKOFF_MIN_MS;
    try {
      while (!signal.aborted) {
        let reply: ReadReply;
        try {
          if (cursor === null) {
            cursor = await this.untilAborted(pendingStart ?? this.latestId(stream), signal);
            pendingStart = null;
          }
          reply = (await blocking.xread(
            "COUNT",
            BATCH,
            "BLOCK",
            this.tailBlockMs,
            "STREAMS",
            stream,
            cursor,
          )) as ReadReply;
        } catch (err) {
          if (signal.aborted) break;
          pendingStart = null;
          this.logger.warn({
            msg: `Leitura do tail em ${stream} falhou; nova tentativa do mesmo cursor`,
            err,
            stream,
          });
          await this.sleep(backoff, signal);
          backoff = Math.min(backoff * 2, TAIL_BACKOFF_MAX_MS);
          continue;
        }
        backoff = TAIL_BACKOFF_MIN_MS;
        for (const [, entries] of reply ?? []) {
          for (const [id, fields] of entries) {
            if (signal.aborted) break;
            cursor = id; // avança mesmo se a entrada for inválida ou o listener falhar
            const parsed = this.parse(fields);
            if (!parsed.ok) {
              this.logger.warn({
                msg: "Entrada inválida ignorada no tail",
                stream,
                entryId: id,
                reason: parsed.error,
              });
              continue;
            }
            try {
              onEvent(parsed.event);
            } catch (err) {
              this.logger.error({ msg: "Listener do tail falhou", err, stream, entryId: id });
            }
          }
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      blocking.disconnect();
    }
  }

  /** Id da última entrada do stream, ou `0-0` se estiver vazio ou não existir. */
  private async latestId(stream: StreamName): Promise<string> {
    const rows = await this.redis.xrevrange(stream, "+", "-", "COUNT", 1);
    return rows[0]?.[0] ?? "0-0";
  }

  /** Rejeita assim que o sinal abortar, sem esperar uma promessa que pode estar pendurada. */
  private untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Error("tail abortado"));
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  /** Reivindica pendentes ociosas e as reprocessa (ou manda para a DLQ). */
  private async reclaim(opts: ConsumeOptions): Promise<void> {
    const { stream, group, consumer, signal } = opts;
    let cursor = "0-0";
    do {
      if (signal.aborted) return;
      let res: [string, RawEntry[], ...unknown[]];
      try {
        res = (await this.redis.xautoclaim(
          stream,
          group,
          consumer,
          this.claimIdleMs,
          cursor,
          "COUNT",
          BATCH,
        )) as [string, RawEntry[], ...unknown[]];
      } catch (err) {
        this.logger.error({ msg: "XAUTOCLAIM falhou", err, stream, group });
        return;
      }
      cursor = res[0];
      for (const [id, fields] of res[1]) {
        if (signal.aborted) return;
        await this.safely(stream, id, async () => {
          // Entradas apagadas do stream chegam sem campos; só confirma.
          if (fields === null) {
            await this.redis.xack(stream, group, id);
            return;
          }
          await this.processEntry(opts, id, fields, await this.deliveries(stream, group, id));
        });
      }
    } while (cursor !== "0-0");
  }

  /**
   * Isola o processamento de uma entrada: erro do Redis (SET/GET/XACK/DEL/DLQ) é registrado com o
   * stack e a entrada fica pendente para o XAUTOCLAIM tentar de novo; o loop segue.
   */
  private async safely(stream: string, id: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error({
        msg: "Falha ao processar a entrada; ficará pendente para nova tentativa",
        err,
        stream,
        entryId: id,
      });
    }
  }

  private async deliveries(stream: string, group: string, id: string): Promise<number> {
    const rows = (await this.redis.xpending(stream, group, id, id, 1)) as [
      string,
      string,
      number,
      number,
    ][];
    return rows[0]?.[3] ?? 1;
  }

  private parse(
    fields: string[] | null,
  ): { ok: true; event: StreamEvent } | { ok: false; error: string; raw: unknown } {
    const raw = fieldOf(fields, "data");
    if (raw === undefined) return { ok: false, error: "campo data ausente", raw: fields };
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: `JSON inválido: ${errMessage(err)}`, raw };
    }
    const parsed = StreamEventSchema.safeParse(json);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        raw: json,
      };
    }
    return { ok: true, event: parsed.data };
  }

  private async processEntry(
    opts: ConsumeOptions,
    id: string,
    fields: string[] | null,
    deliveries: number,
  ): Promise<void> {
    const { stream, group, handler } = opts;
    const parsed = this.parse(fields);
    if (!parsed.ok) {
      this.logger.error({
        msg: "Entrada inválida enviada à DLQ",
        stream,
        entryId: id,
        reason: parsed.error,
      });
      await this.deadLetter(stream, group, id, parsed.raw, parsed.error);
      return;
    }
    const event = parsed.event;

    // Excedeu o limite (ex.: consumidores que morreram sem registrar falha).
    if (deliveries > this.maxDeliveries) {
      await this.deadLetter(stream, group, id, event, "máximo de entregas excedido");
      return;
    }

    // O valor do dedup é o id da entrada: a redelivery da mesma entrada prossegue; outra entrada
    // com o mesmo eventId é duplicata e só recebe ACK.
    const dedupKey = `dedup:${stream}:${event.eventId}`;
    const acquired = await this.redis.set(dedupKey, id, "EX", DEDUP_TTL_SECONDS, "NX");
    if (acquired === null && (await this.redis.get(dedupKey)) !== id) {
      await this.redis.xack(stream, group, id);
      return;
    }

    try {
      await handler(event);
    } catch (err) {
      this.logger.error({
        msg: "Handler do stream falhou",
        err,
        stream,
        group,
        entryId: id,
        eventId: event.eventId,
        eventType: event.type,
        tenantId: event.tenantId,
        clientId: event.clientId,
        deliveries,
        maxDeliveries: this.maxDeliveries,
      });
      await this.redis.del(dedupKey);
      if (deliveries >= this.maxDeliveries) {
        await this.deadLetter(stream, group, id, event, errMessage(err));
      }
      return;
    }
    await this.redis.xack(stream, group, id);
  }

  private async deadLetter(
    stream: StreamName,
    group: string,
    id: string,
    event: unknown,
    error: string,
  ): Promise<void> {
    // XADD antes do XACK, em dois passos: um MULTI não desfaz o XACK se o XADD falhar (erro de
    // execução, ex. WRONGTYPE/OOM). Uma queda entre os dois deixa DLQ duplicada (at-least-once).
    const dlqId = await this.redis.xadd(
      `${stream}.dlq`,
      "*",
      "data",
      JSON.stringify({ event, error }),
    );
    if (dlqId === null) throw new Error(`XADD em ${stream}.dlq não devolveu id`);
    await this.redis.xack(stream, group, id);
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
