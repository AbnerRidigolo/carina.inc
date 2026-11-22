import { describe, expect, it } from "vitest";
import { ChatEventSchema } from "./chat.js";
import { StreamEventSchema } from "./ingestion.js";
import { PortfolioAlertPageSchema, PortfolioAlertSchema } from "./monitor.js";

const alert = {
  id: "3f1c2a64-8d0e-4b8e-9a53-0f7c1b2d4e61",
  assetCode: "PETR4",
  direction: "down",
  changePct: "-5.230000",
  price: "36.10",
  tradingDay: "2026-11-21",
  createdAt: "2026-11-21T14:30:00.000Z",
};

describe("contratos do alerta de carteira", () => {
  it("PortfolioAlert aceita alerta válido e recusa direction fora de up/down", () => {
    expect(PortfolioAlertSchema.safeParse(alert).success).toBe(true);
    expect(PortfolioAlertSchema.safeParse({ ...alert, direction: "up" }).success).toBe(true);
    expect(PortfolioAlertSchema.safeParse({ ...alert, direction: "flat" }).success).toBe(false);
    expect(PortfolioAlertSchema.safeParse({ ...alert, tradingDay: "21/11/2026" }).success).toBe(
      false,
    );
  });

  it("changePct e price são strings decimais (número cru é recusado)", () => {
    expect(PortfolioAlertSchema.safeParse({ ...alert, changePct: -5.23 }).success).toBe(false);
    expect(PortfolioAlertSchema.safeParse({ ...alert, price: 36.1 }).success).toBe(false);
    expect(PortfolioAlertSchema.safeParse({ ...alert, price: "-1" }).success).toBe(false);
  });

  it("PortfolioAlertPage aceita página com cursor nulo ou texto", () => {
    expect(PortfolioAlertPageSchema.safeParse({ items: [alert], nextCursor: null }).success).toBe(
      true,
    );
    expect(PortfolioAlertPageSchema.safeParse({ items: [], nextCursor: "abc" }).success).toBe(true);
    expect(PortfolioAlertPageSchema.safeParse({ items: [alert] }).success).toBe(false);
  });

  it("ChatEvent aceita portfolio_alert", () => {
    expect(ChatEventSchema.safeParse({ type: "portfolio_alert", alert }).success).toBe(true);
    expect(ChatEventSchema.safeParse({ type: "portfolio_alert" }).success).toBe(false);
  });

  it("StreamEvent aceita monitor.alert e recusa sem tenantId", () => {
    const event = {
      type: "monitor.alert",
      eventId: "7a1c2a64-8d0e-4b8e-9a53-0f7c1b2d4e62",
      tenantId: "t1",
      clientId: "c1",
      alert,
    };
    expect(StreamEventSchema.safeParse(event).success).toBe(true);
    expect(StreamEventSchema.safeParse({ ...event, tenantId: undefined }).success).toBe(false);
  });
});
