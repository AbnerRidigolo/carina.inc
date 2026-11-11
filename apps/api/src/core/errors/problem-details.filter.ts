import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Problem } from "@carina/shared";
import { ZodValidationException } from "nestjs-zod";
import { DomainError } from "./domain-errors.js";

interface HttpReq {
  id?: unknown;
}
interface HttpRes {
  /** Lido pelo pino-http: o erro (com stack) entra no log da resposta, nunca no corpo. */
  err?: unknown;
  setHeader(name: string, value: string): unknown;
  status(code: number): HttpRes;
  send(body: unknown): unknown;
}

const PROBLEM_BASE = "https://carina.app/problems";

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<HttpReq>();
    const res = http.getResponse<HttpRes>();
    const traceId = req.id === undefined || req.id === null ? "unknown" : String(req.id);

    let problem: Problem;
    let retryAfter: number | undefined;

    if (exception instanceof DomainError) {
      problem = {
        type: `${PROBLEM_BASE}/${exception.code}`,
        title: exception.name,
        status: exception.status,
        detail: exception.message,
        traceId,
      };
      retryAfter = exception.retryAfterSeconds;
    } else if (exception instanceof ZodValidationException) {
      const zodError = exception.getZodError() as {
        issues: { path: PropertyKey[]; message: string }[];
      };
      problem = {
        type: `${PROBLEM_BASE}/validation_error`,
        title: "Validação falhou",
        status: 422,
        detail: zodError.issues
          .map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`)
          .join("; "),
        traceId,
      };
    } else if (exception instanceof HttpException) {
      problem = {
        type: `${PROBLEM_BASE}/http_${exception.getStatus()}`,
        title: exception.name,
        status: exception.getStatus(),
        detail: exception.message,
        traceId,
      };
    } else {
      res.err = exception;
      problem = {
        type: `${PROBLEM_BASE}/internal_error`,
        title: "Erro interno",
        status: 500,
        traceId,
      };
    }

    if (retryAfter !== undefined) res.setHeader("Retry-After", String(retryAfter));
    res.setHeader("Content-Type", "application/problem+json");
    res.status(problem.status).send(problem);
  }
}
