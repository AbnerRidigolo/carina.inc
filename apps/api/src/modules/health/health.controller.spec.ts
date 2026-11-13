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
    const body = await new HealthController({ postgres: ok, redis: never }, 100).ready(
      res as never,
    );
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
