import type { ChatEvent, StreamEvent } from "@carina/shared";
import { describe, expect, it, vi } from "vitest";
import { InboxBroadcast, type InboxSubscriber } from "./inbox-broadcast.js";

const TA = "aaaaaaaa-1111-4111-8111-11111111111a";
const TB = "bbbbbbbb-1111-4111-8111-11111111111b";
const CX = "22222222-2222-4222-8222-222222222221";
const CY = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";

function setup() {
  let handler: ((e: StreamEvent) => void) | undefined;
  const tail = vi.fn((_stream: string, h: (e: StreamEvent) => void) => {
    handler = h;
    return Promise.resolve();
  });
  const inbox = { get: vi.fn(), executionOf: vi.fn() };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const broadcast = new InboxBroadcast({ tail } as never, inbox as never, logger as never);
  broadcast.onModuleInit();
  const sub = (tenantId: string, clientId: string) => {
    const got: ChatEvent[] = [];
    const subscriber: InboxSubscriber = {
      tenantId,
      clientId,
      clientExternalId: "ext",
      send: (e) => void got.push(e),
    };
    broadcast.subscribe(subscriber);
    return got;
  };
  const emit = (e: StreamEvent) => handler?.(e);
  return { broadcast, inbox, emit, sub, logger };
}

const progress = (tenantId: string, clientId: string, processed: number): StreamEvent => ({
  eventId: crypto.randomUUID(),
  tenantId,
  clientId,
  type: "import.progress",
  importJobId: JOB,
  stage: "writing",
  processed,
  total: 10,
});
const finished = (tenantId: string, clientId: string): StreamEvent => ({
  eventId: crypto.randomUUID(),
  tenantId,
  clientId,
  type: "import.finished",
  importJobId: JOB,
  status: "done",
});

describe("InboxBroadcast: eventos de importação", () => {
  it("entrega só ao inscrito da chave (A/X), na ordem progress → finished, sem ler o banco", async () => {
    const { broadcast, inbox, emit, sub } = setup();
    const ax = sub(TA, CX);
    const ay = sub(TA, CY);
    const bx = sub(TB, CX);

    emit(progress(TA, CX, 3));
    emit(finished(TA, CX));
    await broadcast.onModuleDestroy();

    expect(ax).toEqual([
      { type: "import_progress", importJobId: JOB, stage: "writing", processed: 3, total: 10 },
      { type: "import_finished", importJobId: JOB, status: "done" },
    ]);
    expect(ay).toEqual([]);
    expect(bx).toEqual([]);
    expect(inbox.get).not.toHaveBeenCalled();
  });

  it("falha de envio a um socket não impede os demais nem derruba a cadeia", async () => {
    const { broadcast, emit, sub, logger } = setup();
    broadcast.subscribe({
      tenantId: TA,
      clientId: CX,
      clientExternalId: "ext",
      send: () => {
        throw new Error("socket fechado");
      },
    });
    const ok = sub(TA, CX);
    emit(progress(TA, CX, 1));
    emit(finished(TA, CX));
    await broadcast.onModuleDestroy();
    expect(ok).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("sem assinante da chave, o evento é ignorado", async () => {
    const { broadcast, emit, sub } = setup();
    const ay = sub(TA, CY);
    emit(finished(TA, CX));
    await broadcast.onModuleDestroy();
    expect(ay).toEqual([]);
  });
});

describe("InboxBroadcast: alertas da carteira", () => {
  const alert = {
    id: "44444444-4444-4444-8444-444444444444",
    assetCode: "PETR4",
    direction: "up" as const,
    changePct: "5.2",
    price: "38.1",
    tradingDay: "2026-11-20",
    createdAt: "2026-11-20T15:00:00.000Z",
  };
  const monitorAlert = (tenantId: string, clientId: string): StreamEvent => ({
    eventId: crypto.randomUUID(),
    tenantId,
    clientId,
    type: "monitor.alert",
    alert,
  });

  it("monitor.alert vira portfolio_alert só para a chave do evento, sem ler o banco", async () => {
    const { broadcast, inbox, emit, sub } = setup();
    const ax = sub(TA, CX);
    const ay = sub(TA, CY);
    const bx = sub(TB, CX);

    emit(monitorAlert(TA, CX));
    await broadcast.onModuleDestroy();

    expect(ax).toEqual([{ type: "portfolio_alert", alert }]);
    expect(ay).toEqual([]);
    expect(bx).toEqual([]);
    expect(inbox.get).not.toHaveBeenCalled();
  });

  it("falha de envio a um socket não impede os demais", async () => {
    const { broadcast, emit, sub, logger } = setup();
    broadcast.subscribe({
      tenantId: TA,
      clientId: CX,
      clientExternalId: "ext",
      send: () => {
        throw new Error("socket fechado");
      },
    });
    const ok = sub(TA, CX);
    emit(monitorAlert(TA, CX));
    await broadcast.onModuleDestroy();
    expect(ok).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});
