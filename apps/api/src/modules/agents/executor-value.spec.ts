/**
 * O `valueBrl` de uma proposta é afirmado pelo modelo e é a base da taxa de execução. Sem fonte de
 * preço no servidor, ele não é derivado; mas quando o próprio payload traz como conferir (um valor
 * explícito, ou quantidade × preço unitário), a proposta inconsistente é recusada como as demais
 * saídas ruins do modelo (AllProvidersFailedError).
 */
import type { ActionProposal } from "@carina/shared";
import { describe, expect, it } from "vitest";
import { AllProvidersFailedError } from "../../core/errors/domain-errors.js";
import { refineProposal } from "./executor.js";

const proposal = (over: Partial<ActionProposal>): ActionProposal => ({
  action: "transfer",
  payload: {},
  valueBrl: "100.00",
  rationale: "r",
  ...over,
});

describe("refineProposal: coerência do valueBrl com o payload", () => {
  it("ação que não move dinheiro (create_alert) não é conferida: `price` é o limite do alerta", () => {
    const alert = proposal({
      action: "create_alert",
      payload: { assetCode: "PETR4", price: 42.5, value: 10, description: "avise" },
      valueBrl: "0.00",
    });
    expect(refineProposal(alert).valueBrl).toBe("0.00");
  });

  it("sem dados no payload para conferir: aceita (o valor fica como afirmado)", () => {
    expect(refineProposal(proposal({ payload: { to: "x" } })).valueBrl).toBe("100.00");
    const trade = proposal({
      action: "place_trade",
      payload: { side: "buy", assetCode: "PETR4", quantity: 100 },
      valueBrl: "3000.00",
    });
    expect(refineProposal(trade).valueBrl).toBe("3000.00");
  });

  it("valor explícito no payload igual ao valueBrl: aceita (sinal ignorado)", () => {
    expect(() => refineProposal(proposal({ payload: { amount: "100" } }))).not.toThrow();
    expect(() => refineProposal(proposal({ payload: { valor: -100 } }))).not.toThrow();
  });

  it("valor explícito no payload diferente do valueBrl: recusa", () => {
    expect(() => refineProposal(proposal({ payload: { amount: 10 } }))).toThrow(
      AllProvidersFailedError,
    );
    expect(() => refineProposal(proposal({ payload: { value_brl: "100.01" } }))).toThrow(
      AllProvidersFailedError,
    );
  });

  it("quantidade × preço unitário no payload: precisa bater com o valueBrl (2 casas)", () => {
    const trade = (valueBrl: string, unitPriceBrl: unknown) =>
      proposal({
        action: "place_trade",
        payload: { side: "buy", assetCode: "PETR4", quantity: 100, unitPriceBrl },
        valueBrl,
      });
    expect(() => refineProposal(trade("3000.00", "30.00"))).not.toThrow();
    expect(() => refineProposal(trade("3000.50", 30.005))).not.toThrow();
    expect(() => refineProposal(trade("1.00", "30.00"))).toThrow(AllProvidersFailedError);
    expect(() => refineProposal(trade("3000.00", "abc"))).toThrow(AllProvidersFailedError);
  });
});
