import { randomUUID } from "node:crypto";
import type { StreamEvent } from "@carina/shared";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../src/core/errors/domain-errors.js";
import { StreamsService, type StreamName } from "../../src/core/redis/streams.service.js";
import { redisUrl } from "../setup/db.js";

// DB lógico dedicado a este arquivo (o ioredis não aplica keyPrefix ao XGROUP); esvaziado a cada teste.
const TEST_DB = 11;
function dbUrl(): string {
  const url = new URL(redisUrl());
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}
const silent = { error: vi.fn(), warn: vi.fn() };

/**
 * Registro no formato objeto do pino (R14): `{ msg, err, stream, ... }` com o Error no topo (o
 * serializador do pino só trata `err` no topo e grava message + stack). Devolve o registro cujo
 * `err` tem `text` na mensagem e um stack de verdade.
 */
function loggedError(calls: unknown[][], text: string): Record<string, unknown> | undefined {
  for (const [first] of calls) {
    if (typeof first !== "object" || first === null) continue;
    const rec = first as Record<string, unknown>;
    const err = rec["err"];
    if (
      err instanceof Error &&
      err.message.includes(text) &&
      typeof err.stack === "string" &&
      err.stack.includes("at ") &&
      typeof rec["msg"] === "string" &&
      typeof rec["stream"] === "string"
    ) {
      return rec;
    }
  }
  return undefined;
}

function ev(): StreamEvent {
  return {
    eventId: randomUUID(),
    tenantId: "t1",
    clientId: "c1",
    type: "data.ingested",
    source: "api",
  };
}

async function until(cond: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout aguardando condição");
}

describe("StreamsService", () => {
  let redis: Redis;
  let svc: StreamsService;

  beforeEach(async () => {
    redis = new Redis(dbUrl());
    await redis.flushdb();
    svc = new StreamsService(redis, { claimIdleMs: 150, blockMs: 100, logger: silent });
  });

  afterEach(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  function run(stream: StreamName, handler: (e: StreamEvent) => Promise<void>) {
    const ac = new AbortController();
    const done = svc.consume({ stream, group: "g", consumer: "c1", handler, signal: ac.signal });
    return {
      stop: async () => {
        ac.abort();
        await done;
      },
    };
  }

  const pending = async (stream: string) => {
    try {
      const r = (await redis.xpending(stream, "g")) as [number, ...unknown[]];
      return r[0];
    } catch {
      return -1; // grupo ainda não criado
    }
  };

  it("entrega o evento uma vez e deixa XPENDING em 0", async () => {
    const seen: StreamEvent[] = [];
    const c = run("inbox.events", async (e) => {
      seen.push(e);
    });
    const e = ev();
    await svc.publish("inbox.events", e);
    await until(async () => seen.length === 1 && (await pending("inbox.events")) === 0);
    await c.stop();
    expect(seen).toEqual([e]);
  });

  it("repete após erro e conclui com uma chamada bem-sucedida", async () => {
    let calls = 0;
    let ok = 0;
    const c = run("notifications", async () => {
      calls++;
      if (calls === 1) throw new Error("falha transitória");
      ok++;
    });
    await svc.publish("notifications", ev());
    await until(async () => ok === 1 && (await pending("notifications")) === 0);
    await c.stop();
    expect(calls).toBe(2);
    expect(ok).toBe(1);
    // A falha do handler é registrada com o stack, no formato objeto (R14).
    expect(loggedError(silent.error.mock.calls, "falha transitória")).toMatchObject({
      stream: "notifications",
      eventId: expect.any(String),
    });
  });

  it("manda para jobs.dlq após 5 entregas", async () => {
    let calls = 0;
    const c = run("jobs", async () => {
      calls++;
      throw new Error("sempre falha");
    });
    const e = ev();
    await svc.publish("jobs", e);
    await until(async () => (await redis.xlen("jobs.dlq")) === 1);
    await c.stop();
    expect(calls).toBe(5);
    const [entry] = await redis.xrange("jobs.dlq", "-", "+");
    const fields = entry?.[1] ?? [];
    const payload = JSON.parse(fields[fields.indexOf("data") + 1] ?? "{}");
    expect(payload.event).toEqual(e);
    expect(payload.error).toContain("sempre falha");
    expect(await pending("jobs")).toBe(0);
  });

  it("o mesmo eventId publicado duas vezes chama o handler uma só vez", async () => {
    const stream: StreamName = "inbox.events";
    let calls = 0;
    const c = run(stream, async () => {
      calls++;
    });
    const e = ev();
    await svc.publish(stream, e);
    await svc.publish(stream, e);
    await until(async () => (await pending(stream)) === 0 && calls >= 1);
    await new Promise((r) => setTimeout(r, 300));
    await c.stop();
    expect(calls).toBe(1);
  });

  it("evento inválido no publish lança ValidationError", async () => {
    await expect(
      svc.publish("jobs", { type: "nope", eventId: "x" } as unknown as StreamEvent),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("entrada inválida no stream vai direto para a DLQ e não derruba o loop", async () => {
    const stream: StreamName = "notifications";
    const before = await redis.xlen("notifications.dlq");
    const seen: StreamEvent[] = [];
    const c = run(stream, async (e) => {
      seen.push(e);
    });
    await redis.xadd(stream, "*", "data", "{not json");
    const good = ev();
    await svc.publish(stream, good);
    await until(() => seen.length === 1);
    await until(async () => (await redis.xlen("notifications.dlq")) === before + 1);
    await c.stop();
    expect(seen[0]).toEqual(good);
  });

  it("consume para prontamente com o abort", async () => {
    const slow = new StreamsService(redis, { blockMs: 5000, logger: silent });
    const ac = new AbortController();
    const p = slow.consume({
      stream: "jobs",
      group: "g-abort",
      consumer: "c",
      handler: async () => undefined,
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 200));
    const t = Date.now();
    ac.abort();
    await p;
    expect(Date.now() - t).toBeLessThan(1000);
  });

  describe("tail", () => {
    const stream: StreamName = "inbox.events";

    /** Contador com marcos aguardáveis: sincronização por evento, nunca por sleep. */
    function counter() {
      let n = 0;
      const waiters: { k: number; resolve: () => void }[] = [];
      return {
        get n() {
          return n;
        },
        bump() {
          n++;
          for (const w of waiters.filter((x) => x.k <= n)) w.resolve();
        },
        reached(k: number): Promise<void> {
          if (n >= k) return Promise.resolve();
          return new Promise((resolve) => waiters.push({ k, resolve }));
        },
      };
    }

    interface ProbeHooks {
      /** Antes do XREAD real da n-ésima chamada; lançar simula uma falha transitória. */
      before?: (n: number) => Promise<void> | void;
      /** Depois do XREAD real e antes de devolvê-lo ao tail: a janela entre duas leituras. */
      after?: (n: number, reply: unknown) => Promise<void> | void;
    }

    /** Instrumenta a conexão bloqueante (duplicate) que o tail usa para o XREAD. */
    function probeTail(hooks: ProbeHooks = {}) {
      const conns: Redis[] = [];
      const cursors: string[] = [];
      const issued = counter();
      const completed = counter();
      const realDuplicate = redis.duplicate.bind(redis);
      vi.spyOn(redis, "duplicate").mockImplementation((...args) => {
        const conn = realDuplicate(...args);
        conns.push(conn);
        const target = conn as unknown as { xread: (...a: unknown[]) => Promise<unknown> };
        const realXread = target.xread.bind(conn);
        target.xread = async (...a: unknown[]) => {
          const n = issued.n + 1;
          cursors.push(String(a[a.length - 1]));
          issued.bump();
          try {
            await hooks.before?.(n);
            const reply = await realXread(...a);
            await hooks.after?.(n, reply);
            return reply;
          } finally {
            completed.bump();
          }
        };
        return conn;
      });
      return { conns, cursors, issued, completed };
    }

    function collector() {
      const seen: StreamEvent[] = [];
      const reached = counter();
      return {
        seen,
        onEvent: (e: StreamEvent) => {
          seen.push(e);
          reached.bump();
        },
        count: (k: number) => reached.reached(k),
      };
    }

    function start(opts: ConstructorParameters<typeof StreamsService>[1] = {}) {
      const logger = { error: vi.fn(), warn: vi.fn() };
      const tailSvc = new StreamsService(redis, { tailBlockMs: 50, logger, ...opts });
      const ac = new AbortController();
      const c = collector();
      const done = tailSvc.tail(stream, c.onEvent, ac.signal);
      return {
        logger,
        c,
        stop: async () => {
          ac.abort();
          await done;
        },
        ac,
        done,
      };
    }

    it("entrega eventos novos sem grupo e para no abort", async () => {
      const probe = probeTail();
      const t = start();
      await probe.issued.reached(1);
      const e = ev();
      await svc.publish(stream, e);
      await t.c.count(1);
      await t.stop();
      expect(t.c.seen).toEqual([e]);
    });

    it("RACE: evento publicado entre um BLOCK vazio e o próximo XREAD não se perde", async () => {
      const e = ev();
      let firstReply: unknown = "unset";
      const probe = probeTail({
        after: async (n, reply) => {
          if (n !== 1) return;
          firstReply = reply;
          await svc.publish(stream, e); // a janela: XREAD #1 já voltou vazio, #2 ainda não saiu
        },
      });
      const t = start();
      await probe.completed.reached(3);
      await t.stop();
      expect(firstReply).toBeNull();
      expect(t.c.seen).toEqual([e]);
    });

    it("RACE: evento publicado logo após tail() e antes do primeiro XREAD é entregue uma vez", async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const probe = probeTail({ before: (n) => (n === 1 ? gate : undefined) });
      const t = start();
      const e = ev();
      await svc.publish(stream, e); // antes de qualquer XREAD do tail ter sido enviado
      release();
      await probe.completed.reached(3);
      await t.stop();
      expect(t.c.seen).toEqual([e]);
    });

    it("entrega, em ordem e uma só vez, eventos publicados ao longo de vários BLOCKs", async () => {
      const probe = probeTail();
      const t = start({ tailBlockMs: 30 });
      await probe.issued.reached(1);
      const published: StreamEvent[] = [];
      for (let i = 0; i < 4; i++) {
        await probe.completed.reached(i + 2); // pelo menos mais um BLOCK terminou
        const e = ev();
        published.push(e);
        await svc.publish(stream, e);
      }
      await t.c.count(4);
      await probe.completed.reached(probe.completed.n + 2); // mais leituras: nada duplica
      await t.stop();
      expect(t.c.seen).toEqual(published);
      expect(probe.completed.n).toBeGreaterThanOrEqual(6);
    });

    it("stream vazio ou inexistente: começa em 0-0 e entrega o primeiro evento", async () => {
      const probe = probeTail();
      const t = start();
      await probe.issued.reached(1);
      const e = ev();
      await svc.publish(stream, e);
      await t.c.count(1);
      await t.stop();
      expect(probe.cursors[0]).toBe("0-0");
      expect(t.c.seen).toEqual([e]);
    });

    it("stream com histórico: não reenvia o passado e parte do último id", async () => {
      const history = [ev(), ev(), ev()];
      let lastHistoryId = "";
      for (const h of history) lastHistoryId = await svc.publish(stream, h);
      const probe = probeTail();
      const t = start();
      await probe.issued.reached(1);
      const e = ev();
      await svc.publish(stream, e);
      await t.c.count(1);
      await probe.completed.reached(probe.completed.n + 2);
      await t.stop();
      expect(probe.cursors[0]).toBe(lastHistoryId);
      expect(t.c.seen).toEqual([e]);
    });

    it("erro de leitura: espera e repete do MESMO cursor (nunca volta a $), com log { msg, err, stream }", async () => {
      const e0 = ev();
      const e1 = ev();
      let id0 = "";
      const probe = probeTail({
        before: async (n) => {
          if (n === 1) {
            id0 = await svc.publish(stream, e0);
            throw new Error("blip 1");
          }
          if (n === 3) {
            await svc.publish(stream, e1);
            throw new Error("blip 3");
          }
        },
      });
      const t = start();
      await t.c.count(2);
      await t.stop();
      expect(t.c.seen).toEqual([e0, e1]);
      expect(probe.cursors.slice(0, 4)).toEqual(["0-0", "0-0", id0, id0]);
      expect(probe.cursors).not.toContain("$");
      expect(t.logger.warn).toHaveBeenCalledTimes(2);
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ msg: expect.any(String), err: expect.any(Error), stream }),
      );
    });

    it("falha transitória ao resolver o id inicial é repetida e nunca cai em $", async () => {
      vi.spyOn(redis, "xrevrange").mockRejectedValueOnce(new Error("blip no XREVRANGE"));
      const probe = probeTail();
      const t = start();
      await probe.issued.reached(1);
      const e = ev();
      await svc.publish(stream, e);
      await t.c.count(1);
      await t.stop();
      expect(probe.cursors[0]).toBe("0-0");
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), stream }),
      );
    });

    it("entrada inválida é registrada e ignorada; o cursor avança e o loop segue", async () => {
      const probe = probeTail();
      const t = start();
      await probe.issued.reached(1);
      await redis.xadd(stream, "*", "data", "{not json");
      const good = ev();
      const goodId = await svc.publish(stream, good);
      await t.c.count(1);
      await probe.issued.reached(probe.issued.n + 1);
      await t.stop();
      expect(t.c.seen).toEqual([good]);
      expect(probe.cursors[probe.cursors.length - 1]).toBe(goodId);
      expect(t.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ stream }));
    });

    it("para prontamente com o abort durante o BLOCK e desconecta a conexão bloqueante", async () => {
      const probe = probeTail();
      const t = start({ tailBlockMs: 5000 });
      await probe.issued.reached(1);
      const t0 = Date.now();
      await t.stop();
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(probe.conns[0]?.status).toBe("end");
    });

    it("abort antes de iniciar retorna sem abrir conexão", async () => {
      const probe = probeTail();
      const ac = new AbortController();
      ac.abort();
      await svc.tail(stream, () => undefined, ac.signal);
      expect(probe.conns).toHaveLength(0);
    });
  });

  describe("falhas transitórias do Redis durante o processamento", () => {
    function runWithLogger(handler: (e: StreamEvent) => Promise<void>) {
      const logger = { error: vi.fn(), warn: vi.fn() };
      const s = new StreamsService(redis, { claimIdleMs: 150, blockMs: 100, logger });
      const ac = new AbortController();
      let settled: "pending" | "resolved" | "rejected" = "pending";
      const done = s
        .consume({ stream: "jobs", group: "g", consumer: "c1", handler, signal: ac.signal })
        .then(
          () => {
            settled = "resolved";
          },
          () => {
            settled = "rejected";
          },
        );
      return {
        logger,
        state: () => settled,
        stop: async () => {
          ac.abort();
          await done;
        },
      };
    }

    it("XACK que falha uma vez não encerra o consume; a entrega se repete e conclui", async () => {
      vi.spyOn(redis, "xack").mockRejectedValueOnce(new Error("blip no XACK"));
      let calls = 0;
      const c = runWithLogger(async () => {
        calls++;
      });
      await svc.publish("jobs", ev());
      await until(async () => calls >= 2 && (await pending("jobs")) === 0);
      expect(c.state()).toBe("pending");
      await c.stop();
      expect(c.state()).toBe("resolved");
      expect(calls).toBe(2);
    });

    it("DEL que falha após erro do handler não encerra o consume e registra o stack", async () => {
      vi.spyOn(redis, "del").mockRejectedValueOnce(new Error("blip no DEL"));
      let calls = 0;
      const c = runWithLogger(async () => {
        calls++;
        if (calls === 1) throw new Error("falha do handler");
      });
      await svc.publish("jobs", ev());
      await until(async () => calls === 2 && (await pending("jobs")) === 0);
      expect(c.state()).toBe("pending");
      await c.stop();
      expect(c.state()).toBe("resolved");
      expect(loggedError(c.logger.error.mock.calls, "blip no DEL")).toMatchObject({
        stream: "jobs",
        entryId: expect.any(String),
      });
    });

    it("XADD da DLQ falhando de verdade (WRONGTYPE) deixa a entrada pendente até a DLQ voltar", async () => {
      await redis.set("jobs.dlq", "não sou um stream");
      let calls = 0;
      const c = runWithLogger(async () => {
        calls++;
        throw new Error("sempre falha");
      });
      await svc.publish("jobs", ev());
      await until(() => loggedError(c.logger.error.mock.calls, "WRONGTYPE") !== undefined);
      // Algumas tentativas de reprocessar a movimentação, sempre falhando: nada é confirmado.
      await new Promise((r) => setTimeout(r, 500));
      expect(c.state()).toBe("pending");
      expect(await pending("jobs")).toBe(1);
      expect(calls).toBe(5);
      expect(await redis.get("jobs.dlq")).toBe("não sou um stream");

      await redis.del("jobs.dlq");
      await until(
        async () => (await redis.xlen("jobs.dlq")) === 1 && (await pending("jobs")) === 0,
      );
      await c.stop();
      expect(c.state()).toBe("resolved");
    });
  });
});
