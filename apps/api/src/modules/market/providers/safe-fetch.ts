import { Logger } from "@nestjs/common";
import { MarketDataUnavailableError } from "../../../core/errors/domain-errors.js";

/**
 * Único caminho de saída do módulo `market` para a rede. Tudo o que chega daqui é tratado como
 * não confiável: prazo curto (`AbortSignal.timeout`), sem seguir redirecionamento, corpo lido em
 * fluxo com teto de bytes, status 2xx e JSON obrigatórios. Qualquer falha vira
 * `MarketDataUnavailableError` (mensagem fixa); o motivo vai para o log só com o host, nunca com a
 * URL completa, a query, cabeçalhos ou o corpo.
 */

/** Forma de OBJETO (nestjs-pino): `err` no topo, como nos outros serviços. */
export interface MarketLogFields {
  msg: string;
  err?: unknown;
  [field: string]: unknown;
}

export interface MarketLogger {
  warn(fields: MarketLogFields): void;
}

export const defaultMarketLogger = (): MarketLogger => new Logger("MarketData");

export interface SafeFetchOptions {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  maxBytes: number;
  headers?: Record<string, string>;
  logger?: MarketLogger;
}

export interface SafeFetchResponseOptions extends SafeFetchOptions {
  /**
   * Status fora de 2xx que a chamada quer tratar ela mesma (ex.: `[404]`). O corpo continua lido
   * com o limite de bytes e precisa ser JSON; qualquer outro status fora de 2xx lança.
   */
  allowStatuses?: readonly number[];
}

export interface SafeFetchResult {
  status: number;
  body: unknown;
}

type FailureReason =
  | "unsupported_url"
  | "network"
  | "timeout"
  | "http_status"
  | "body_too_large"
  | "invalid_body"
  | "invalid_json";

/**
 * Erro que vai para o log. A mensagem é montada só com o motivo e dados seguros (nome do erro,
 * código do sistema, status): nunca com a mensagem original, que pode trazer a URL ou o corpo
 * (o `SyntaxError` do `JSON.parse` cita trechos da entrada, por exemplo).
 */
export class MarketFetchFailure extends Error {
  constructor(
    readonly reason: FailureReason,
    detail?: string,
    readonly status?: number,
  ) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
    this.name = "MarketFetchFailure";
  }
}

const ALLOWED_PROTOCOLS = new Set(["https:", "http:"]);

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** Nome do erro e, se houver, o código do sistema da causa (`ENOTFOUND`, `ECONNRESET`...). */
function safeErrorDescription(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const code =
    typeof cause?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(cause.code) ? cause.code : "";
  return code ? `${name} ${code}` : name;
}

async function cancelQuietly(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body || body.locked) return;
  await body.cancel().catch(() => undefined);
}

/** Lê o corpo em fluxo e para (cancelando o leitor) assim que passa de `maxBytes`. */
async function readCapped(res: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await cancelQuietly(res.body);
    throw new MarketFetchFailure("body_too_large");
  }
  if (!res.body) throw new MarketFetchFailure("invalid_body", "empty");

  const reader = res.body.getReader();
  // O prazo vale também para a leitura: um corpo que trava no meio é cancelado.
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (signal.aborted) throw new MarketFetchFailure("timeout");
        throw new MarketFetchFailure("invalid_body", safeErrorDescription(err));
      }
      if (signal.aborted) throw new MarketFetchFailure("timeout");
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MarketFetchFailure("body_too_large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MarketFetchFailure("invalid_body", "utf8");
  }
}

async function fetchJson(url: URL, opts: SafeFetchResponseOptions): Promise<SafeFetchResult> {
  if (!ALLOWED_PROTOCOLS.has(url.protocol) || url.username !== "" || url.password !== "") {
    throw new MarketFetchFailure("unsupported_url");
  }
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", ...opts.headers },
      // Nunca segue redirecionamento: o host é só o da configuração.
      redirect: "error",
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw new MarketFetchFailure("timeout");
    throw new MarketFetchFailure("network", safeErrorDescription(err));
  }
  const allowed = opts.allowStatuses?.includes(res.status) === true;
  if ((res.status < 200 || res.status > 299) && !allowed) {
    await cancelQuietly(res.body);
    throw new MarketFetchFailure("http_status", String(res.status), res.status);
  }
  const text = await readCapped(res, opts.maxBytes, signal);
  try {
    return { status: res.status, body: JSON.parse(text) as unknown };
  } catch {
    throw new MarketFetchFailure("invalid_json");
  }
}

/**
 * GET de JSON com as proteções acima (só 2xx). A URL deve vir de `buildProviderUrl` (base da
 * configuração); quem chama nunca escolhe o host.
 */
export async function safeFetchJson(url: URL, opts: SafeFetchOptions): Promise<unknown> {
  return (await safeFetchJsonResponse(url, opts)).body;
}

/**
 * Igual a `safeFetchJson`, mas devolve o status e aceita, por chamada, status fora de 2xx listados
 * em `allowStatuses` (com as mesmas proteções de prazo, bytes e JSON).
 */
export async function safeFetchJsonResponse(
  url: URL,
  opts: SafeFetchResponseOptions,
): Promise<SafeFetchResult> {
  try {
    return await fetchJson(url, opts);
  } catch (err) {
    const failure =
      err instanceof MarketFetchFailure
        ? err
        : new MarketFetchFailure("invalid_body", safeErrorDescription(err));
    (opts.logger ?? defaultMarketLogger()).warn({
      msg: "Falha ao consultar provedor de dados de mercado",
      err: failure,
      host: url.host,
      reason: failure.reason,
      ...(failure.status === undefined ? {} : { status: failure.status }),
    });
    throw new MarketDataUnavailableError();
  }
}

/**
 * No máximo UMA tentativa extra, e só quando o `fetch` rejeita por erro de rede. Resposta HTTP
 * (qualquer status) e aborto por prazo não se repetem; o sinal é o mesmo, então o prazo cobre as
 * duas tentativas.
 */
export function withNetworkRetry(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    try {
      return await fetchImpl(input, init);
    } catch (err) {
      if (init?.signal?.aborted === true || isAbortError(err)) throw err;
      return fetchImpl(input, init);
    }
  };
}

/** Segmento já validado; um array vira uma lista separada por vírgula (cada item codificado). */
export type UrlSegment = string | readonly string[];

function encodeSegment(segment: UrlSegment): string {
  const parts = typeof segment === "string" ? [segment] : segment;
  if (parts.length === 0) throw new MarketDataUnavailableError();
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") throw new MarketDataUnavailableError();
  }
  return parts.map((p) => encodeURIComponent(p)).join(",");
}

/**
 * Monta a URL do provedor a partir da base da CONFIGURAÇÃO: os segmentos são codificados com
 * `encodeURIComponent` (uma `/` ou `..` nunca muda o caminho) e a query vai por `URLSearchParams`.
 * Query e fragmento da base são descartados, e a origem do resultado é conferida.
 */
export function buildProviderUrl(
  baseUrl: string,
  segments: readonly UrlSegment[],
  query: Record<string, string> = {},
): URL {
  const base = new URL(baseUrl);
  if (!ALLOWED_PROTOCOLS.has(base.protocol)) throw new MarketDataUnavailableError();
  const url = new URL(base.origin);
  const basePath = base.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/${segments.map(encodeSegment).join("/")}`;
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  if (url.origin !== base.origin) throw new MarketDataUnavailableError();
  return url;
}
