/**
 * Utilitários dos testes de chat (REST e WebSocket).
 */
import type { ChatEvent } from "@carina/shared";
import { vi } from "vitest";
import { AllProvidersFailedError } from "../../src/core/errors/domain-errors.js";
import { type MockResponder, MockResponderRegistry } from "../../src/modules/llm/mock-models.js";
import { OrchestratorService } from "../../src/modules/orchestrator/orchestrator.service.js";
import type { TestApp } from "../setup/app.js";

/**
 * Registro de mocks com um interruptor: ligado, TODO responder (classificador, agentes, Navigator)
 * lança `AllProvidersFailedError`, como a cadeia live quando todos os provedores caem.
 */
export class FailingMockRegistry extends MockResponderRegistry {
  failing = false;

  override resolve(mockKey: string): MockResponder {
    const real = super.resolve(mockKey);
    return (input) => {
      if (this.failing) throw new AllProvidersFailedError();
      return real(input);
    };
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

/** `Promise.withResolvers` (fora da lib ES2023 do tsconfig). */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export interface Gate {
  /** Resolve quando o primeiro evento do orquestrador foi repassado. */
  reached: Promise<void>;
  /** Libera o resto do turno. */
  release(): void;
  restore(): void;
}

/**
 * Segura o turno depois do PRIMEIRO evento do orquestrador (o `plan`), até `release()`: deixa o
 * teste agir (desconectar, mandar outro turno) com o grafo no meio da execução.
 */
export function gateOrchestrator(t: TestApp): Gate {
  const orchestrator = t.app.get(OrchestratorService);
  const original = orchestrator.stream.bind(orchestrator);
  const reached = deferred<undefined>();
  const gate = deferred<undefined>();
  const spy = vi
    .spyOn(orchestrator, "stream")
    .mockImplementation(async function* (input): AsyncGenerator<ChatEvent> {
      let first = true;
      for await (const e of original(input)) {
        yield e;
        if (first) {
          first = false;
          reached.resolve(undefined);
          await gate.promise;
        }
      }
    });
  return {
    reached: reached.promise,
    release: () => gate.resolve(undefined),
    restore: () => spy.mockRestore(),
  };
}

/** Espera `check()` dar verdadeiro (poll curto), com prazo. */
export async function eventually(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
  what = "condição",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Tempo esgotado esperando ${what}`);
}
