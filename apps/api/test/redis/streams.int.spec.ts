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
    expect(silent.error).toHaveBeenCalled();
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

  it("tail entrega eventos novos sem grupo e para no abort", async () => {
    const stream: StreamName = "inbox.events";
    const seen: StreamEvent[] = [];
    const ac = new AbortController();
    const done = svc.tail(stream, (e) => seen.push(e), ac.signal);
    await new Promise((r) => setTimeout(r, 200));
    const e = ev();
    await svc.publish(stream, e);
    await until(() => seen.some((s) => s.eventId === e.eventId));
    ac.abort();
    await done;
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
      const withStack = c.logger.error.mock.calls.find((args) =>
        args.some((a) => typeof a === "string" && a.includes("blip no DEL") && a.includes("at ")),
      );
      expect(withStack).toBeDefined();
    });

    it("XADD da DLQ falhando de verdade (WRONGTYPE) deixa a entrada pendente até a DLQ voltar", async () => {
      await redis.set("jobs.dlq", "não sou um stream");
      let calls = 0;
      const c = runWithLogger(async () => {
        calls++;
        throw new Error("sempre falha");
      });
      await svc.publish("jobs", ev());
      await until(() =>
        c.logger.error.mock.calls.some(
          (a) => String(a[0]).includes("WRONGTYPE") && String(a[1]).includes("at "),
        ),
      );
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
