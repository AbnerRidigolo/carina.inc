import { StreamEventSchema, type StreamEvent } from "@carina/shared";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { Redis } from "ioredis";
import { ValidationError } from "../errors/domain-errors.js";
import { REDIS } from "./redis.tokens.js";

export type StreamName = "inbox.events" | "notifications" | "jobs";

export const STREAMS_OPTIONS = Symbol("STREAMS_OPTIONS");

export interface StreamsLogger {
  error(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
}

export interface StreamsOptions {
  /** Tempo ocioso (ms) após o qual uma pendente é reivindicada por XAUTOCLAIM. */
  claimIdleMs?: number;
  /** Entregas após as quais o evento vai para a DLQ. */
  maxDeliveries?: number;
  /** Duração do BLOCK das leituras (ms). */
  blockMs?: number;
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
  private readonly logger: StreamsLogger;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Optional() @Inject(STREAMS_OPTIONS) opts: StreamsOptions = {},
  ) {
    this.claimIdleMs = opts.claimIdleMs ?? 60_000;
    this.maxDeliveries = opts.maxDeliveries ?? 5;
    this.blockMs = opts.blockMs ?? 5000;
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
          this.logger.error(`XREADGROUP em ${stream} falhou: ${errMessage(err)}`);
          await this.sleep(500, signal);
          continue;
        }
        for (const [, entries] of reply ?? []) {
          for (const [id, fields] of entries) {
            if (signal.aborted) break;
            await this.processEntry(opts, id, fields, 1);
          }
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      blocking.disconnect();
    }
  }

  async tail(
    stream: StreamName,
    onEvent: (e: StreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    const blocking = this.redis.duplicate();
    blocking.on("error", () => undefined);
    const onAbort = () => blocking.disconnect();
    signal.addEventListener("abort", onAbort, { once: true });
    let lastId = "$";
    try {
      while (!signal.aborted) {
        let reply: ReadReply;
        try {
          reply = (await blocking.xread(
            "COUNT",
            BATCH,
            "BLOCK",
            this.blockMs,
            "STREAMS",
            stream,
            lastId,
          )) as ReadReply;
        } catch (err) {
          if (signal.aborted) break;
          this.logger.error(`XREAD em ${stream} falhou: ${errMessage(err)}`);
          await this.sleep(500, signal);
          continue;
        }
        for (const [, entries] of reply ?? []) {
          for (const [id, fields] of entries) {
            lastId = id;
            const parsed = this.parse(fields);
            if (!parsed.ok) {
              this.logger.warn(`Entrada inválida ignorada em ${stream} (${id}): ${parsed.error}`);
              continue;
            }
            try {
              onEvent(parsed.event);
            } catch (err) {
              this.logger.error(`Listener de tail em ${stream} falhou: ${errMessage(err)}`);
            }
          }
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      blocking.disconnect();
    }
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
        this.logger.error(`XAUTOCLAIM em ${stream} falhou: ${errMessage(err)}`);
        return;
      }
      cursor = res[0];
      for (const [id, fields] of res[1]) {
        if (signal.aborted) return;
        // Entradas apagadas do stream chegam sem campos; só confirma.
        if (fields === null) {
          await this.redis.xack(stream, group, id);
          continue;
        }
        await this.processEntry(opts, id, fields, await this.deliveries(stream, group, id));
      }
    } while (cursor !== "0-0");
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
      this.logger.error(`Entrada inválida em ${stream} (${id}) enviada à DLQ: ${parsed.error}`);
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
      this.logger.error(
        `Handler de ${stream} falhou para ${event.eventId} (entrega ${deliveries}/${this.maxDeliveries}): ${errMessage(err)}`,
      );
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
    await this.redis
      .multi()
      .xadd(`${stream}.dlq`, "*", "data", JSON.stringify({ event, error }))
      .xack(stream, group, id)
      .exec();
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
