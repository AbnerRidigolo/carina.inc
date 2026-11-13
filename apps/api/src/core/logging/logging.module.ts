/**
 * Logs JSON com nestjs-pino (pino-http por requisição + o Logger do Nest apontado para o pino via
 * `app.useLogger(app.get(Logger))` no bootstrap).
 *
 * Regras do log de requisição:
 * - `tenantId` e `keyId` entram no registro de fim da requisição (`customProps`, lido de
 *   `req.tenant`, que o ApiKeyGuard preenche); nunca a chave nem o hash.
 * - A URL vai SEM query string e o objeto `query` não é registrado: o ticket do WebSocket e
 *   qualquer token em query nunca chegam ao log. (O upgrade do WebSocket nem passa pelo Express,
 *   então o pino-http não o registra; o serializador cobre qualquer outro caminho.)
 * - `authorization`, `x-api-key`, `cookie` e `set-cookie` são mascarados (redact), além dos
 *   campos pessoais conhecidos.
 * - `/api/health` e `/api/ready` não geram log de requisição (healthchecks a cada poucos segundos).
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type DynamicModule, Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import type { DestinationStream } from "pino";
import type { Options } from "pino-http";
import { ENV } from "../config/config.module.js";
import type { Env } from "../config/env.js";

/** `x-request-id` aceito do cliente: até 128 caracteres de `[A-Za-z0-9._:-]`. */
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Id da requisição (traceId dos Problem Details e dos logs): o `x-request-id` do cliente se for
 * curto e de caracteres seguros (vai para logs e cabeçalhos de resposta); senão, um uuid novo.
 */
export function requestIdFrom(header: string | string[] | undefined): string {
  return typeof header === "string" && REQUEST_ID_RE.test(header) ? header : randomUUID();
}

export const REDACT_PATHS = [
  "req.headers.authorization",
  'req.headers["x-api-key"]',
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.apiKey",
  "*.cpf",
  "*.email",
  "*.phone",
];

/** Rotas de healthcheck: sem log de requisição. */
const QUIET_PATHS = new Set(["/api/health", "/api/ready"]);

/** Caminho sem query string nem fragmento. */
export function pathOnly(url: string | undefined): string {
  if (!url) return "";
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

interface SerializedReq {
  id?: unknown;
  method?: unknown;
  url?: string;
  query?: unknown;
  params?: unknown;
  headers?: Record<string, unknown>;
  remoteAddress?: unknown;
  remotePort?: unknown;
}

/** O que o pino-http lê do `req` do Express depois do ApiKeyGuard. */
interface RequestWithTenant extends IncomingMessage {
  tenant?: { tenantId?: unknown; keyId?: unknown };
}

/** Ids do tenant da requisição autenticada; `{}` antes do guard ou em rota pública. */
export function tenantLogProps(req: IncomingMessage): Record<string, string> {
  const t = (req as RequestWithTenant).tenant;
  if (!t || typeof t.tenantId !== "string" || typeof t.keyId !== "string") return {};
  return { tenantId: t.tenantId, keyId: t.keyId };
}

export function buildPinoHttpOptions(env: Pick<Env, "LOG_LEVEL">): Options {
  return {
    level: env.LOG_LEVEL,
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const id = requestIdFrom(req.headers["x-request-id"]);
      res.setHeader("x-request-id", id);
      return id;
    },
    customProps: (req: IncomingMessage) => tenantLogProps(req),
    autoLogging: { ignore: (req: IncomingMessage) => QUIET_PATHS.has(pathOnly(req.url)) },
    serializers: {
      // Recebe a requisição já serializada pelo pino-std-serializers (wrapSerializers).
      req: (req: SerializedReq) => ({
        id: req.id,
        method: req.method,
        url: pathOnly(req.url),
        headers: req.headers,
        remoteAddress: req.remoteAddress,
        remotePort: req.remotePort,
      }),
    },
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  };
}

export interface LoggingOptions {
  /** Destino dos logs (padrão: stdout). Os testes passam um stream em memória. */
  destination?: DestinationStream;
}

/**
 * `LoggingModule.forRoot()` no AppModule e no WorkerModule. O nível vem do Env validado
 * (`LOG_LEVEL`), não de `process.env` solto.
 */
@Module({})
export class LoggingModule {
  static forRoot(opts: LoggingOptions = {}): DynamicModule {
    return {
      module: LoggingModule,
      imports: [
        LoggerModule.forRootAsync({
          inject: [ENV],
          useFactory: (env: Env) => {
            const options = buildPinoHttpOptions(env);
            return { pinoHttp: opts.destination ? [options, opts.destination] : options };
          },
        }),
      ],
      exports: [LoggerModule],
    };
  }
}
