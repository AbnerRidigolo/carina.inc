import { describe, expect, it, vi } from "vitest";
import { QuotaExceededError, ValidationError } from "../../core/errors/domain-errors.js";
import type { BillingService } from "../billing/billing.service.js";
import type { QuotaService } from "../limits/quota.service.js";
import type { AuthTenant } from "../tenancy/api-key.guard.js";
import { EvaluationController } from "./evaluation.controller.js";

const tenant: AuthTenant = {
  keyId: "k1",
  tenantId: "t1",
  tenantName: "Tenant",
  scopes: ["eval:run"],
  rpm: 100,
  monthlyQuota: 10,
};

const body = { answers: { "acoes-isencao-20k": "isento até R$ 20.000 por mês" } };

function setup(opts: { record?: () => Promise<unknown>; refund?: () => Promise<void> } = {}) {
  const billing = { record: vi.fn(opts.record ?? (() => Promise.resolve({}))) };
  const quota = {
    reserve: vi.fn(() => Promise.resolve()),
    refund: vi.fn(opts.refund ?? (() => Promise.resolve())),
  };
  const controller = new EvaluationController(
    billing as unknown as BillingService,
    () => 0,
    quota as unknown as QuotaService,
  );
  return { controller, billing, quota };
}

describe("EvaluationController.submit: cota mensal", () => {
  it("reserva a cota depois de corrigir e antes de cobrar; sucesso não devolve", async () => {
    const { controller, billing, quota } = setup();
    const report = await controller.submit(tenant, body);
    expect(report.answered).toBe(1);
    expect(quota.reserve).toHaveBeenCalledWith(tenant);
    expect(billing.record).toHaveBeenCalledTimes(1);
    expect(quota.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      billing.record.mock.invocationCallOrder[0] ?? 0,
    );
    expect(quota.refund).not.toHaveBeenCalled();
  });

  it("quando o record falha, devolve a cota e repassa o erro", async () => {
    const boom = new Error("db fora");
    const { controller, quota } = setup({ record: () => Promise.reject(boom) });
    await expect(controller.submit(tenant, body)).rejects.toBe(boom);
    expect(quota.refund).toHaveBeenCalledWith(tenant);
  });

  it("se o refund também falha, o erro original do record é que sobe", async () => {
    const boom = new Error("db fora");
    const { controller, quota } = setup({
      record: () => Promise.reject(boom),
      refund: () => Promise.reject(new Error("redis fora")),
    });
    await expect(controller.submit(tenant, body)).rejects.toBe(boom);
    expect(quota.refund).toHaveBeenCalledTimes(1);
  });

  it("caso inexistente (422) não reserva cota nem cobra", async () => {
    const { controller, billing, quota } = setup();
    await expect(controller.submit(tenant, { answers: { "nao-existe": "x" } })).rejects.toThrow(
      ValidationError,
    );
    expect(quota.reserve).not.toHaveBeenCalled();
    expect(billing.record).not.toHaveBeenCalled();
  });

  it("cota esgotada (429) não cobra nem devolve", async () => {
    const { controller, billing, quota } = setup();
    quota.reserve.mockRejectedValueOnce(new QuotaExceededError("Cota mensal esgotada", 60));
    await expect(controller.submit(tenant, body)).rejects.toThrow(QuotaExceededError);
    expect(billing.record).not.toHaveBeenCalled();
    expect(quota.refund).not.toHaveBeenCalled();
  });
});
