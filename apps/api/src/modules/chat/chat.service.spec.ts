import { describe, expect, it } from "vitest";
import {
  AllProvidersFailedError,
  NotFoundError,
  ThreadBusyError,
  ValidationError,
} from "../../core/errors/domain-errors.js";
import { parseChatRequest, publicErrorCode, threadIdFor, threadLockKey } from "./chat.service.js";

const T = "aaaaaaaa-1111-4111-8111-11111111111b";
const C = "22222222-2222-4222-8222-222222222222";

describe("threadIdFor", () => {
  it("sem threadId gera um novo no espaço do tenant e do cliente", () => {
    const a = threadIdFor(T, C);
    const b = threadIdFor(T, C);
    expect(a).toMatch(new RegExp(`^${T}:${C}:[0-9a-f-]{36}$`));
    expect(a).not.toBe(b);
  });

  it("aceita o thread do mesmo tenant e cliente", () => {
    expect(threadIdFor(T, C, `${T}:${C}:abc_1-2`)).toBe(`${T}:${C}:abc_1-2`);
  });

  it("thread de outro cliente/tenant ou malformado: NotFoundError", () => {
    const other = "33333333-3333-4333-8333-333333333333";
    for (const bad of [
      `${T}:${other}:x`,
      `${other}:${C}:x`,
      `${T}:${C}:`,
      `${T}:${C}:a:b`,
      `${T}:${C}:${"x".repeat(129)}`,
      `${T.toUpperCase()}:${C}:x`,
      "x",
    ]) {
      expect(() => threadIdFor(T, C, bad), bad).toThrow(NotFoundError);
    }
  });

  it("chave do lock por thread", () => {
    expect(threadLockKey(`${T}:${C}:x`)).toBe(`chat:thread:${T}:${C}:x`);
  });
});

describe("parseChatRequest", () => {
  it("valida e faz trim", () => {
    expect(parseChatRequest({ clientId: "c1", message: "  oi " })).toEqual({
      clientId: "c1",
      message: "oi",
    });
  });

  it("inválido: ValidationError sem ecoar o texto recebido", () => {
    const secret = "segredo-do-cliente";
    let err: unknown;
    try {
      parseChatRequest({ clientId: secret + " x", message: "a".repeat(8001) });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).not.toContain(secret);
    expect(() => parseChatRequest(undefined)).toThrow(ValidationError);
  });
});

describe("publicErrorCode", () => {
  it("código do erro de domínio; qualquer outro vira internal_error", () => {
    expect(publicErrorCode(new AllProvidersFailedError())).toBe("all_providers_failed");
    expect(publicErrorCode(new ThreadBusyError("x"))).toBe("thread_busy");
    expect(publicErrorCode(new Error("detalhe interno do provedor"))).toBe("internal_error");
    expect(publicErrorCode("x")).toBe("internal_error");
  });
});
