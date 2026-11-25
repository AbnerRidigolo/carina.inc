import type { HistoricalBar } from "@carina/shared";
import { describe, expect, it, vi } from "vitest";
import {
  MarketDataBusyError,
  MarketDataUnavailableError,
  NotFoundError,
  QuotaExceededError,
  ValidationError,
} from "../../core/errors/domain-errors.js";
import type { TenantPrismaService } from "../../core/database/tenant-prisma.service.js";
import type { BillingService } from "../billing/billing.service.js";
import type { QuotaService } from "../limits/quota.service.js";
import type { MarketService } from "../market/market.service.js";
import type { AuthTenant } from "../tenancy/api-key.guard.js";
import { BuilderController } from "./builder.controller.js";
import type { StrategyRepository } from "./strategy.repository.js";

const tenant: AuthTenant = {
  keyId: "k1",
  tenantId: "t1",
  tenantName: "Tenant",
  scopes: ["builder:run"],
  rpm: 100,
  monthlyQuota: 10,
};

const ID = "11111111-1111-4111-8111-111111111111";
const strategy = {
  id: ID,
  name: "Buy and hold",
  spec: { kind: "buy_hold" as const, symbol: "PETR4", fast: 10, slow: 50 },
  createdAt: "2026-11-25T00:00:00.000Z",
};

function bars(n: number): HistoricalBar[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    open: "10.00",
    high: "11.00",
    low: "9.00",
    close: String(10 + i),
    volume: "100",
  }));
}

function setup(
  opts: {
    found?: typeof strategy | null;
    history?: () => Promise<HistoricalBar[]>;
    record?: () => Promise<unknown>;
    refund?: () => Promise<void>;
  } = {},
) {
  const billing = { record: vi.fn(opts.record ?? (() => Promise.resolve({}))) };
  const quota = {
    reserve: vi.fn(() => Promise.resolve()),
    refund: vi.fn(opts.refund ?? (() => Promise.resolve())),
  };
  const market = { history: vi.fn(opts.history ?? (() => Promise.resolve(bars(5)))) };
  const repo = {
    get: vi.fn(() => Promise.resolve(opts.found === undefined ? strategy : opts.found)),
    create: vi.fn(),
    list: vi.fn(),
  };
  const db = { tx: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})) };
  const controller = new BuilderController(
    db as unknown as TenantPrismaService,
    repo as unknown as StrategyRepository,
    market as unknown as MarketService,
    billing as unknown as BillingService,
    () => 0,
    quota as unknown as QuotaService,
  );
  return { controller, billing, quota, market, repo };
}

describe("BuilderController.backtest", () => {
  it("valida tudo antes de reservar: reserva depois do motor e antes de cobrar; sucesso não devolve", async () => {
    const { controller, billing, quota, market } = setup();
    const res = await controller.backtest(tenant, ID, { range: "1y" });
    expect(market.history).toHaveBeenCalledWith("PETR4", "1y");
    expect(res.usage).toEqual({ workType: "backtest", priceBrl: "7.50" });
    expect(quota.reserve).toHaveBeenCalledWith(tenant);
    expect(quota.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      billing.record.mock.invocationCallOrder[0] ?? 0,
    );
    expect(billing.record).toHaveBeenCalledTimes(1);
    expect(quota.refund).not.toHaveBeenCalled();
  });

  it("falha na cobrança estorna a cota e repassa o erro", async () => {
    const boom = new Error("db fora");
    const { controller, quota } = setup({ record: () => Promise.reject(boom) });
    await expect(controller.backtest(tenant, ID, { range: "1y" })).rejects.toBe(boom);
    expect(quota.refund).toHaveBeenCalledWith(tenant);
  });

  it("se o estorno também falha, o erro original da cobrança é que sobe", async () => {
    const boom = new Error("db fora");
    const { controller, quota } = setup({
      record: () => Promise.reject(boom),
      refund: () => Promise.reject(new Error("redis fora")),
    });
    await expect(controller.backtest(tenant, ID, { range: "1y" })).rejects.toBe(boom);
    expect(quota.refund).toHaveBeenCalledTimes(1);
  });

  it("estratégia inexistente (404) não busca histórico, não reserva nem cobra", async () => {
    const { controller, billing, quota, market } = setup({ found: null });
    await expect(controller.backtest(tenant, ID, { range: "1y" })).rejects.toThrow(NotFoundError);
    expect(market.history).not.toHaveBeenCalled();
    expect(quota.reserve).not.toHaveBeenCalled();
    expect(billing.record).not.toHaveBeenCalled();
  });

  it.each([
    ["orçamento esgotado", new MarketDataBusyError(30)],
    ["provedor fora", new MarketDataUnavailableError()],
  ])("%s no histórico não reserva cota nem cobra", async (_n, err) => {
    const { controller, billing, quota } = setup({ history: () => Promise.reject(err) });
    await expect(controller.backtest(tenant, ID, { range: "1y" })).rejects.toBe(err);
    expect(quota.reserve).not.toHaveBeenCalled();
    expect(billing.record).not.toHaveBeenCalled();
  });

  it("histórico insuficiente (422) não reserva cota nem cobra", async () => {
    const { controller, billing, quota } = setup({
      found: { ...strategy, spec: { ...strategy.spec, kind: "sma_cross" as never, slow: 50 } },
    });
    await expect(controller.backtest(tenant, ID, { range: "1y" })).rejects.toThrow(ValidationError);
    expect(quota.reserve).not.toHaveBeenCalled();
    expect(billing.record).not.toHaveBeenCalled();
  });

  it("cota esgotada (429) não cobra nem estorna", async () => {
    const { controller, billing, quota } = setup();
    quota.reserve.mockRejectedValueOnce(new QuotaExceededError("Cota mensal esgotada", 60));
    await expect(controller.backtest(tenant, ID, { range: "1y" })).rejects.toThrow(
      QuotaExceededError,
    );
    expect(billing.record).not.toHaveBeenCalled();
    expect(quota.refund).not.toHaveBeenCalled();
  });
});
