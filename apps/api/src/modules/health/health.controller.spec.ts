import { describe, expect, it, vi } from "vitest";
import { pingPostgres } from "../../core/database/database-health.js";
import { pingRedis } from "../../core/redis/redis-health.js";
import { HealthController, type ReadinessProbes } from "./health.controller.js";

const SECRET_URL = "postgres://carina_app:senha-super-secreta@db.interno:5432/carina";

function fakeRes() {
  return { status: vi.fn() };
}

const ok = () => Promise.resolve();
const never = () => new Promise<void>(() => undefined);

describe("HealthController", () => {
  it("health: sempre { status: 'ok' } (liveness, sem dependências)", () => {
    const c = new HealthController({ postgres: never, redis: never });
    expect(c.health()).toEqual({ status: "ok" });
  });

  it("ready: os dois ok → 200 e { postgres: 'ok', redis: 'ok' }", async () => {
    const res = fakeRes();
    const c = new HealthController({ postgres: ok, redis: ok });
    expect(await c.ready(res as never)).toEqual({ postgres: "ok", redis: "ok" });
    expect(res.status).not.toHaveBeenCalled();
  });

  it("ready: Postgres falhando → 503 só com o nome do serviço, sem texto do erro", async () => {
    const res = fakeRes();
    const probes: ReadinessProbes = {
      postgres: () => Promise.reject(new Error(`connect ECONNREFUSED ${SECRET_URL}`)),
      redis: ok,
    };
    const body = await new HealthController(probes).ready(res as never);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(body).toEqual({ postgres: "fail", redis: "ok" });
    expect(JSON.stringify(body)).not.toContain("senha");
  });

  it("ready: Redis pendurado → 503 dentro do prazo, sem esperar a sonda", async () => {
    const res = fakeRes();
    const started = Date.now();
    const body = await new HealthController(
      { postgres: ok, redis: never },
      { timeoutMs: 100 },
    ).ready(res as never);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(body).toEqual({ postgres: "ok", redis: "fail" });
  });

  it("ready: sonda que lança de forma síncrona também vira fail (não 500)", async () => {
    const res = fakeRes();
    const boom = (): Promise<void> => {
      throw new Error("síncrono");
    };
    const body = await new HealthController({ postgres: boom, redis: boom }).ready(res as never);
    expect(body).toEqual({ postgres: "fail", redis: "fail" });
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

describe("ready: single-flight e cache curto (sem amplificar conexões)", () => {
  /** Relógio controlado pelo teste. */
  function clock(start = 1_000_000) {
    const c = { now: start };
    return { c, fn: () => c.now };
  }

  /** Sonda contável que só resolve quando o teste libera. */
  function gatedProbe() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const probe = vi.fn(() => gate);
    return { probe, release };
  }

  it("N chamadas concorrentes disparam exatamente UMA sondagem de cada serviço", async () => {
    const pg = gatedProbe();
    const rd = gatedProbe();
    const { fn } = clock();
    const c = new HealthController({ postgres: pg.probe, redis: rd.probe }, { clock: fn });
    const calls = Array.from({ length: 50 }, () => c.ready(fakeRes() as never));
    pg.release();
    rd.release();
    const bodies = await Promise.all(calls);
    expect(pg.probe).toHaveBeenCalledTimes(1);
    expect(rd.probe).toHaveBeenCalledTimes(1);
    expect(bodies.every((b) => b.postgres === "ok" && b.redis === "ok")).toBe(true);
  });

  it("dentro do TTL reaproveita o resultado; depois do TTL sonda de novo", async () => {
    const postgres = vi.fn(ok);
    const redis = vi.fn(ok);
    const { c: time, fn } = clock();
    const c = new HealthController({ postgres, redis }, { clock: fn, cacheTtlMs: 1500 });
    await c.ready(fakeRes() as never);
    time.now += 1499;
    await c.ready(fakeRes() as never);
    expect(postgres).toHaveBeenCalledTimes(1);
    expect(redis).toHaveBeenCalledTimes(1);
    time.now += 1;
    await c.ready(fakeRes() as never);
    expect(postgres).toHaveBeenCalledTimes(2);
    expect(redis).toHaveBeenCalledTimes(2);
  });

  it("falha também é reaproveitada no TTL (indisponibilidade não vira tempestade) e mantém o 503", async () => {
    const postgres = vi.fn(() => Promise.reject(new Error(`ECONNREFUSED ${SECRET_URL}`)));
    const redis = vi.fn(ok);
    const { c: time, fn } = clock();
    const c = new HealthController({ postgres, redis }, { clock: fn, cacheTtlMs: 1500 });
    for (let i = 0; i < 5; i++) {
      const res = fakeRes();
      expect(await c.ready(res as never)).toEqual({ postgres: "fail", redis: "ok" });
      expect(res.status).toHaveBeenCalledWith(503);
      time.now += 100;
    }
    expect(postgres).toHaveBeenCalledTimes(1);
    time.now += 1500;
    await c.ready(fakeRes() as never);
    expect(postgres).toHaveBeenCalledTimes(2);
  });

  it("sonda que lança síncrono conta como falha e também fica no cache", async () => {
    const boom = vi.fn((): Promise<void> => {
      throw new Error("síncrono");
    });
    const { fn } = clock();
    const c = new HealthController({ postgres: boom, redis: ok }, { clock: fn });
    expect(await c.ready(fakeRes() as never)).toEqual({ postgres: "fail", redis: "ok" });
    expect(await c.ready(fakeRes() as never)).toEqual({ postgres: "fail", redis: "ok" });
    expect(boom).toHaveBeenCalledTimes(1);
  });

  it("sonda que estourou o prazo e segue pendurada: não abre outra até ela terminar", async () => {
    const pg = gatedProbe();
    const { c: time, fn } = clock();
    const c = new HealthController(
      { postgres: pg.probe, redis: ok },
      { clock: fn, timeoutMs: 20, cacheTtlMs: 1000 },
    );
    expect((await c.ready(fakeRes() as never)).postgres).toBe("fail"); // prazo estourou
    time.now += 5000; // TTL vencido, mas a sonda anterior ainda segura a conexão
    expect((await c.ready(fakeRes() as never)).postgres).toBe("fail");
    expect(pg.probe).toHaveBeenCalledTimes(1);
    // Ela termina: a próxima chamada (TTL já vencido) sonda de novo, agora com sucesso.
    pg.release();
    await new Promise((r) => setTimeout(r, 0));
    expect((await c.ready(fakeRes() as never)).postgres).toBe("ok");
    expect(pg.probe).toHaveBeenCalledTimes(2);
  });
});

describe("sondas reais contra uma porta fechada", () => {
  it("pingPostgres rejeita rápido e não deixa conexão aberta", async () => {
    const started = Date.now();
    await expect(pingPostgres("postgres://u:p@127.0.0.1:1/db", 1000)).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("pingRedis rejeita dentro do prazo (sem fila offline nem reconexão)", async () => {
    const started = Date.now();
    await expect(pingRedis("redis://127.0.0.1:1", 1000)).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
