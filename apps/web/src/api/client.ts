import { ProblemSchema } from "@carina/shared";
import type { ZodType } from "zod";
import { getApiKey } from "../state/session";

/** A API respondeu com um erro (RFC 9457 `Problem` ou, sem corpo válido, só o status HTTP). */
export class ApiProblemError extends Error {
  readonly status: number;
  /** Último trecho do `type` do Problem (`thread_busy`, `rate_limited`...) ou `http_<status>`. */
  readonly code: string;
  readonly traceId: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(init: {
    status: number;
    code: string;
    traceId?: string;
    retryAfterSeconds?: number;
    message?: string;
  }) {
    super(init.message ?? `A API respondeu ${init.status} (${init.code})`);
    this.name = "ApiProblemError";
    this.status = init.status;
    this.code = init.code;
    this.traceId = init.traceId;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** A resposta de sucesso não bate com o schema: o dado não é usado nem renderizado. */
export class ApiValidationError extends Error {
  constructor(path: string) {
    super(`Resposta inesperada da API em ${path}`);
    this.name = "ApiValidationError";
  }
}

/** Sem resposta (rede caiu, proxy fora). */
export class ApiNetworkError extends Error {
  constructor() {
    super("Sem conexão com a API");
    this.name = "ApiNetworkError";
  }
}

export interface ApiFetchInit {
  method?: "GET" | "POST";
  /** Corpo JSON (objeto); serializado aqui. */
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** Chave explícita (tela de conexão, antes de guardá-la). Um 401 aqui não derruba a sessão. */
  apiKey?: string;
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Chamado quando uma requisição da sessão volta 401 (chave revogada/expirada). */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value);
}

function codeOf(type: string, status: number): string {
  const last = type.split("/").at(-1);
  return last && /^[a-z0-9_]+$/.test(last) ? last : `http_${status}`;
}

/**
 * `fetch` para a API. Só caminhos `/api/...` da própria origem (a chave nunca vai para outro
 * host); a chave vai apenas no header `Authorization`. A resposta de sucesso é validada pelo
 * schema; erro vira `ApiProblemError`. Nada do corpo da resposta entra na mensagem do erro.
 */
export async function apiFetch<T>(
  path: string,
  schema: ZodType<T>,
  init: ApiFetchInit = {},
): Promise<T> {
  if (!/^\/api\/[^/]/.test(path))
    throw new Error("apiFetch aceita só caminhos /api/ da mesma origem");
  const key = init.apiKey ?? getApiKey();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const hasBody = init.body !== undefined;
  if (hasBody) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(new URL(path, globalThis.location.origin).href, {
      method: init.method ?? (hasBody ? "POST" : "GET"),
      headers,
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      credentials: "omit",
      cache: "no-store",
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ApiNetworkError();
  }

  let json: unknown;
  try {
    json = JSON.parse(await response.text());
  } catch (err) {
    if (isAbortError(err)) throw err;
    json = undefined;
  }

  if (!response.ok) {
    const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"));
    const problem = ProblemSchema.safeParse(json);
    const error = new ApiProblemError({
      status: response.status,
      code: problem.success
        ? codeOf(problem.data.type, response.status)
        : `http_${response.status}`,
      ...(problem.success ? { traceId: problem.data.traceId } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    });
    if (response.status === 401 && init.apiKey === undefined) {
      for (const listener of [...unauthorizedListeners]) listener();
    }
    throw error;
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiValidationError(path.split("?")[0] ?? path);
  return parsed.data;
}
