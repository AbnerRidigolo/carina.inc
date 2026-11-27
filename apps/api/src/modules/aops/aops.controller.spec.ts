import { AOP_MAX_PER_TENANT, type Aop } from "@carina/shared";
import { describe, expect, it, vi } from "vitest";
import {
  AopDisabledError,
  ManualRunTooSoonError,
  ValidationError,
} from "../../core/errors/domain-errors.js";
import type { AuthTenant } from "../tenancy/api-key.guard.js";
import { AopsController } from "./aops.controller.js";

const TENANT = { tenantId: "00000000-0000-4000-8000-000000000001" } as AuthTenant;
const AOP_ID = "00000000-0000-4000-8000-0000000000aa";

function aop(over: Partial<Aop> = {}): Aop {
  return {
    id: AOP_ID,
    name: "Carteira premium",
    description: "toda sexta, analise o risco",
    agents: ["risk"],
    schedule: { frequency: "weekly", weekday: 4, day: 1, hour: 9 },
    clientIds: ["c-1", "ghost"],
    enabled: true,
    createdAt: "2026-11-27T12:00:00.000Z",
    lastFireAt: "2026-11-27T12:00:00.000Z",
    ...over,
  };
}

function setup(opts: { count?: number; now?: number; found?: Aop | null; won?: boolean } = {}) {
  const tx = {};
  const repo = {
    count: vi.fn(() => Promise.resolve(opts.count ?? 0)),
    create: vi.fn(() => Promise.resolve(aop())),
    unknownClientIds: vi.fn(() => Promise.resolve(["ghost"])),
    get: vi.fn(() => Promise.resolve(opts.found === undefined ? aop() : opts.found)),
  };
  const compiler = {
    compile: vi.fn(() =>
      Promise.resolve({
        name: "Compilado",
        agents: ["risk"],
        schedule: { frequency: "weekly", weekday: 4, day: 1, hour: 9 },
        via: "heuristic",
      }),
    ),
  };
  const streams = { publish: vi.fn(() => Promise.resolve("1-0")) };
  const redis = {
    set: vi.fn(() => Promise.resolve(opts.won === false ? null : "OK")),
    del: vi.fn(() => Promise.resolve(1)),
    pttl: vi.fn(() => Promise.resolve(30_000)),
  };
  const db = { tx: vi.fn((fn: (t: unknown) => unknown) => Promise.resolve(fn(tx))) };
  const now = opts.now ?? Date.parse("2026-11-27T12:05:07.123Z");
  const controller = new AopsController(
    db as never,
    repo as never,
    compiler as never,
    streams as never,
    redis as never,
    () => now,
  );
  return { controller, repo, compiler, streams, redis };
}

const body = { description: "toda sexta, analise o risco", clientIds: ["c-1", "ghost"] };

describe("AopsController.create", () => {
  it("no limite de AOPs → 422 sem chamar o compilador (sem custo de LLM)", async () => {
    const { controller, compiler, repo } = setup({ count: AOP_MAX_PER_TENANT });
    await expect(controller.create(TENANT, body)).rejects.toBeInstanceOf(ValidationError);
    expect(compiler.compile).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("abaixo do limite compila, cria com o relógio e devolve unknownClientIds", async () => {
    const { controller, compiler, repo } = setup({ count: AOP_MAX_PER_TENANT - 1 });
    const created = await controller.create(TENANT, body);
    expect(compiler.compile).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ clientIds: ["c-1", "ghost"] }),
      Date.parse("2026-11-27T12:05:07.123Z"),
    );
    expect(repo.unknownClientIds).toHaveBeenCalledWith(expect.anything(), ["c-1", "ghost"]);
    expect(created.unknownClientIds).toEqual(["ghost"]);
    expect(created.id).toBe(AOP_ID);
  });
});

describe("AopsController.run", () => {
  it("AOP desligado → 409 aop_disabled, sem tocar o guard do minuto", async () => {
    const { controller, redis } = setup({ found: aop({ enabled: false }) });
    const err: unknown = await controller.run(TENANT, AOP_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AopDisabledError);
    expect(err).toMatchObject({ code: "aop_disabled", status: 409 });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("segundo disparo no minuto → 409 manual_run_too_soon com Retry-After", async () => {
    const { controller } = setup({ won: false });
    const err: unknown = await controller.run(TENANT, AOP_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManualRunTooSoonError);
    expect(err).toMatchObject({ code: "manual_run_too_soon", status: 409, retryAfterSeconds: 30 });
  });

  it("fireAt no milissegundo .000 de um minuto cheio ganha +1 ms (nunca igual a um horário agendado)", async () => {
    const whole = Date.parse("2026-11-27T12:00:00.000Z");
    const { controller, streams } = setup({ now: whole });
    const { fireAt } = await controller.run(TENANT, AOP_ID);
    expect(fireAt).toBe("2026-11-27T12:00:00.001Z");
    expect(streams.publish).toHaveBeenCalledWith(
      "jobs",
      expect.objectContaining({ fireAt: "2026-11-27T12:00:00.001Z" }),
    );
  });

  it("fireAt fora do minuto cheio é o instante do pedido, sem ajuste", async () => {
    const { controller } = setup({ now: Date.parse("2026-11-27T12:00:00.500Z") });
    expect((await controller.run(TENANT, AOP_ID)).fireAt).toBe("2026-11-27T12:00:00.500Z");
    const second = setup({ now: Date.parse("2026-11-27T12:00:01.000Z") });
    expect((await second.controller.run(TENANT, AOP_ID)).fireAt).toBe("2026-11-27T12:00:01.000Z");
  });
});
