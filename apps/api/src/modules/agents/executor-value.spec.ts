/**
 * O `valueBrl` de uma proposta é afirmado pelo modelo e é a base da taxa de execução. Em `transfer`
 * e `rebalance` não há fonte de preço no servidor, então ele não é derivado; mas quando o próprio
 * payload traz como conferir (um valor explícito, ou quantidade × preço unitário), a proposta
 * inconsistente é recusada como as demais saídas ruins do modelo (AllProvidersFailedError). Em
 * `place_trade` com ativo cotável o servidor vence (`priceTrade`) e a conferência não se aplica.
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

  it("transfer/rebalance: quantidade × preço unitário precisa bater com o valueBrl (2 casas)", () => {
    for (const action of ["transfer", "rebalance"]) {
      const mk = (valueBrl: string, unitPriceBrl: unknown) =>
        proposal({ action, payload: { quantity: 100, unitPriceBrl }, valueBrl });
      expect(() => refineProposal(mk("3000.00", "30.00"))).not.toThrow();
      expect(() => refineProposal(mk("3000.50", 30.005))).not.toThrow();
      expect(() => refineProposal(mk("1.00", "30.00"))).toThrow(AllProvidersFailedError);
      expect(() => refineProposal(mk("3000.00", "abc"))).toThrow(AllProvidersFailedError);
    }
  });
});

/**
 * Spec 5.5 item 3: para `place_trade` com ativo cotável o servidor vence (o valor vem da cotação,
 * em `priceTrade`), então um `valueBrl` incoerente com o próprio payload não é mais motivo de recusa.
 * O formato do payload continua validado.
 */
describe("refineProposal: place_trade, o servidor vence", () => {
  const trade = (payload: Record<string, unknown>, valueBrl = "3000.00") =>
    proposal({ action: "place_trade", payload, valueBrl });

  it("valueBrl incoerente com o próprio payload agora passa", () => {
    const base = { side: "buy", assetCode: "PETR4", quantity: 100 };
    const incoherent = [
      trade({ ...base, unitPriceBrl: "30.00" }, "1.00"),
      trade({ ...base, price: "abc" }),
      trade({ ...base, valueBrl: "10.00" }),
      trade({ ...base, amount: 10, value_brl: "99" }),
    ];
    for (const p of incoherent) {
      const out = refineProposal(p);
      expect(out.action).toBe("place_trade");
      expect(out.valueBrl).toBe(p.valueBrl);
    }
  });

  it("assetCode inválido (petr4) continua recusado", () => {
    expect(() => refineProposal(trade({ side: "buy", assetCode: "petr4", quantity: 100 }))).toThrow(
      AllProvidersFailedError,
    );
    expect(() =>
      refineProposal(
        trade({ side: "buy", assetCode: "petr4", quantity: 100, unitPriceBrl: "30.00" }),
      ),
    ).toThrow(AllProvidersFailedError);
  });

  it("valueBrl do modelo continua passando pelo checkMoney (negativo é recusado)", () => {
    expect(() =>
      refineProposal(trade({ side: "buy", assetCode: "PETR4", quantity: 100 }, "-1.00")),
    ).toThrow(AllProvidersFailedError);
  });

  it("transfer com valor incoerente continua recusado", () => {
    expect(() => refineProposal(proposal({ payload: { amount: 10 }, valueBrl: "100.00" }))).toThrow(
      AllProvidersFailedError,
    );
  });
});
