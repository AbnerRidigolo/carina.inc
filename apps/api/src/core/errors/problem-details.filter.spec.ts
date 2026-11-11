import { HttpException, type ArgumentsHost } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { ZodValidationException } from "nestjs-zod";
import { z } from "zod";
import { AllProvidersFailedError, NotFoundError, QuotaExceededError } from "./domain-errors.js";
import { ProblemDetailsFilter } from "./problem-details.filter.js";

function run(err: unknown) {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    err: undefined as unknown,
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
      return res;
    },
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    send(b: unknown) {
      res.body = b;
      return res;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ id: "req-1" }) }),
  } as unknown as ArgumentsHost;
  new ProblemDetailsFilter().catch(err, host);
  return { res, headers, body: res.body as Record<string, unknown> };
}

describe("ProblemDetailsFilter", () => {
  it("QuotaExceededError vira 429 com Retry-After e problem+json", () => {
    const { res, headers, body } = run(new QuotaExceededError("cota esgotada", 120));
    expect(res.statusCode).toBe(429);
    expect(headers["retry-after"]).toBe("120");
    expect(headers["content-type"]).toBe("application/problem+json");
    expect(body.traceId).toBe("req-1");
    expect(body.status).toBe(429);
  });

  it("AllProvidersFailedError usa 503 e retryAfter 30", () => {
    const { res, headers } = run(new AllProvidersFailedError());
    expect(res.statusCode).toBe(503);
    expect(headers["retry-after"]).toBe("30");
  });

  it("erro desconhecido vira 500 sem vazar detalhes", () => {
    const { res, body } = run(new Error("senha do banco xyz"));
    expect(res.statusCode).toBe(500);
    expect(body.title).toBe("Erro interno");
    expect(body.detail).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("senha");
  });

  it("erro desconhecido fica em res.err para o pino-http registrar o stack", () => {
    const boom = new Error("falha interna");
    expect(run(boom).res.err).toBe(boom);
  });

  it("ZodValidationException vira 422", () => {
    const parsed = z.object({ a: z.string() }).safeParse({});
    if (parsed.success) throw new Error("esperava falha");
    const { res, body } = run(new ZodValidationException(parsed.error));
    expect(res.statusCode).toBe(422);
    expect(body.title).toBe("Validação falhou");
  });

  it("HttpException preserva status", () => {
    expect(run(new HttpException("nada", 418)).res.statusCode).toBe(418);
  });

  it("DomainError comum mapeia status", () => {
    expect(run(new NotFoundError("x")).res.statusCode).toBe(404);
  });
});
