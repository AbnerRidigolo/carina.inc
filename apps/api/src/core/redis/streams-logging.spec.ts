/**
 * Caminho REAL de log do StreamsService (R14): o logger padrão (Logger do Nest) apontado para o
 * nestjs-pino. A falha de leitura do Redis chega ao pino como `{ msg, err, stream, group }` com
 * `err.message` e `err.stack` serializados (o pino só serializa `err` no topo do registro).
 */
import { Logger as NestLogger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Logger, LoggerModule } from "nestjs-pino";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StreamsService } from "./streams.service.js";

describe("logs do StreamsService pelo nestjs-pino real", () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(...chunk.toString().split("\n").filter(Boolean));
      cb();
    },
  });
  let nestApp: Awaited<ReturnType<typeof boot>>;

  async function boot() {
    const ref = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: { stream, level: "info" } })],
    }).compile();
    const app = ref.createNestApplication();
    await app.init();
    return app;
  }

  beforeAll(async () => {
    nestApp = await boot();
    NestLogger.overrideLogger(nestApp.get(Logger));
  });

  afterAll(async () => {
    NestLogger.overrideLogger(["error", "warn", "log"]);
    await nestApp.close();
  });

  it("XREADGROUP falhando: registro com msg, stream, group e err (message + stack)", async () => {
    const ac = new AbortController();
    let reads = 0;
    const blocking = {
      on: () => undefined,
      disconnect: () => undefined,
      xreadgroup: async () => {
        reads++;
        if (reads === 1) throw new Error("conexão caiu no XREADGROUP");
        ac.abort();
        return null;
      },
    };
    const redis = {
      xgroup: async () => "OK",
      xautoclaim: async () => ["0-0", []],
      duplicate: () => blocking,
    };
    const svc = new StreamsService(redis as never, { blockMs: 10 });
    await svc.consume({
      stream: "jobs",
      group: "g1",
      consumer: "c1",
      handler: async () => undefined,
      signal: ac.signal,
    });

    const rec = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r["stream"] === "jobs" && r["err"] !== undefined);
    expect(rec).toBeDefined();
    expect(rec).toMatchObject({ context: "StreamsService", group: "g1", level: 50 });
    expect(typeof rec?.["msg"]).toBe("string");
    const err = rec?.["err"] as { message: string; stack: string };
    expect(err.message).toBe("conexão caiu no XREADGROUP");
    expect(err.stack).toContain("at ");
    // A mensagem do registro não carrega o texto do erro concatenado (fica só em err).
    expect(String(rec?.["msg"])).not.toContain("conexão caiu");
  });
});
