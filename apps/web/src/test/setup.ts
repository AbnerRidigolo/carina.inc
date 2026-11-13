import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { resetSessionForTests } from "../state/session";
import { FakeWebSocket } from "./fake-websocket";

export const server = setupServer();

// Saída pristina: qualquer console.error/warn (inclusive avisos de act()) reprova o teste.
const consoleCalls: string[] = [];

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});

beforeEach(() => {
  consoleCalls.length = 0;
  for (const method of ["error", "warn"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(`console.${method}: ${args.map(String).join(" ")}`);
    });
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);
  FakeWebSocket.reset();
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetSessionForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (consoleCalls.length > 0) {
    throw new Error(`Saída inesperada no console:\n${consoleCalls.join("\n")}`);
  }
});

afterAll(() => {
  server.close();
});
