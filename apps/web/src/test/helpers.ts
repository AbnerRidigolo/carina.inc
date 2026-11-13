import type { ApprovalView } from "@carina/shared";
import { HttpResponse, http } from "msw";
import { server } from "./setup";

export const TEST_KEY = "sk-live-testkey000000000000000000000000";
export const TICKET = "T".repeat(43);

export const CLIENTS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    externalId: "cliente-moderado",
    createdAt: "2026-11-01T10:00:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    externalId: "cliente-arrojado",
    createdAt: "2026-11-02T10:00:00.000Z",
  },
];

export function problem(status: number, code: string, headers: Record<string, string> = {}) {
  return HttpResponse.json(
    {
      type: `https://carina.app/problems/${code}`,
      title: code,
      status,
      detail: `detalhe ${code}`,
      traceId: "trace-1",
    },
    { status, headers: { "Content-Type": "application/problem+json", ...headers } },
  );
}

/** Handler de ticket que devolve um ticket novo a cada chamada (T0000…, T0001…). */
export function ticketHandler(onCall?: (body: unknown, headers: Headers) => void) {
  let n = 0;
  return http.post("*/api/ws/ticket", async ({ request }) => {
    onCall?.(await request.json(), request.headers);
    const ticket = `${String(n++).padStart(4, "0")}`.padEnd(43, "x");
    return HttpResponse.json({ ticket, expiresInSeconds: 30 });
  });
}

export function use(...handlers: Parameters<typeof server.use>) {
  server.use(...handlers);
}

export function approval(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: "a".repeat(64),
    clientId: "cliente-moderado",
    agent: "executor" as const,
    action: "transferir_valores",
    risk: "irreversible" as const,
    payload: { destino: "conta-123", valor: "1500.00" },
    valueBrl: "1500.00",
    status: "pending" as const,
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-11-12T10:00:00.000Z",
    ...overrides,
  };
}

// ---- ajudantes de componente (act em volta de tudo que o "servidor" falso dispara) ----
import { act } from "@testing-library/react";
import { FakeWebSocket } from "./fake-websocket";

export async function openSocket(index = 0): Promise<FakeWebSocket> {
  const { vi, expect } = await import("vitest");
  await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(index));
  const socket = FakeWebSocket.instances[index] as FakeWebSocket;
  act(() => socket.serverOpen());
  return socket;
}

export function emit(socket: FakeWebSocket, ...events: unknown[]): void {
  act(() => {
    for (const e of events) socket.serverMessage(e);
  });
}

export function doneEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "done",
    threadId: "tenant:client:thread-1",
    status: "completed",
    answer: "Resposta final.",
    usage: { workType: "analysis", priceBrl: "7.50" },
    compliance: { auditId: "audit-1", flags: [] },
    ...overrides,
  };
}
