/**
 * Autenticação por chave de API e contexto do tenant.
 *
 * - `ApiKeyGuard` (global): lê `Authorization: Bearer <chave>` ou `X-API-Key`, calcula o sha256
 *   e chama `resolve_api_key(hash)` (SECURITY DEFINER; o carina_app não lê `api_key`). Chave
 *   ausente, malformada, desconhecida ou revogada → o MESMO UnauthenticatedError (401), sem dizer
 *   qual foi o caso. Depois confere os escopos de `@RequireScopes` (403) e grava `req.tenant`.
 * - `TenantContextInterceptor` (global): um guard não envolve o handler, então é o interceptor
 *   que roda o handler inteiro (e tudo o que ele chama, inclusive depois de awaits) dentro de
 *   `TenantContext.run`, o contexto que o TenantPrismaService usa para o RLS.
 *
 * A chave e o hash nunca vão para log nem para a resposta; só `keyId`/`tenantId` podem ser
 * registrados. A comparação do segredo é a busca pelo hash no banco (índice único), nunca uma
 * igualdade de strings na aplicação.
 */
import {
  Inject,
  Injectable,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable } from "rxjs";
import { TenantContext } from "../../core/context/tenant-context.js";
import { PrismaService } from "../../core/database/prisma.service.js";
import { ForbiddenScopeError, UnauthenticatedError } from "../../core/errors/domain-errors.js";
import { hashApiKey } from "./api-key.js";
import {
  IS_PUBLIC_KEY,
  REQUIRED_ANY_SCOPES_KEY,
  REQUIRED_SCOPES_KEY,
  type Scope,
} from "./scopes.decorator.js";

export interface AuthTenant {
  keyId: string;
  tenantId: string;
  tenantName: string;
  scopes: string[];
  rpm: number;
  monthlyQuota: number;
}

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  tenant?: AuthTenant;
}

/** Linha de `resolve_api_key`; `scopes` é NULL quando a coluna (anulável) está NULL. */
interface ResolvedKeyRow {
  key_id: string;
  tenant_id: string;
  tenant_name: string;
  scopes: string[] | null;
  rpm: number;
  monthly_quota: number;
}

/** Uma só mensagem para todos os casos de 401: não revela se a chave existe ou foi revogada. */
const UNAUTHENTICATED_MESSAGE = "Chave de API ausente ou inválida";
/** Chaves geradas têm 40 caracteres; o limite só evita hashear entradas absurdas. */
const MAX_KEY_LENGTH = 256;
/**
 * Formato das chaves geradas (`sk-live-` + 32 base62). Conferido ANTES do banco: sem isto, toda
 * requisição com lixo no header viraria uma consulta a `resolve_api_key` (carga sem limite, já
 * que o rate limit só roda por tenant, depois da autenticação).
 */
const API_KEY_FORMAT = /^sk-live-[0-9A-Za-z]{32}$/;

function unauthenticated(): UnauthenticatedError {
  return new UnauthenticatedError(UNAUTHENTICATED_MESSAGE);
}

/** Extrai a chave dos headers; `undefined` quando ausente ou malformada. */
export function extractApiKey(headers: AuthenticatedRequest["headers"]): string | undefined {
  const authorization = headers["authorization"];
  let candidate: string | undefined;
  if (typeof authorization === "string") {
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization);
    candidate = match?.[1];
  }
  if (candidate === undefined) {
    const header = headers["x-api-key"];
    // Header repetido chega como array: ambíguo, recusado.
    if (typeof header === "string") candidate = header.trim();
  }
  if (!candidate || candidate.length > MAX_KEY_LENGTH) return undefined;
  return candidate;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets)) return true;

    // Só HTTP é autenticado aqui; outro transporte (ex.: WebSocket) sem @Public() falha fechado.
    if (context.getType() !== "http") throw unauthenticated();

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const key = extractApiKey(req.headers);
    // Ausente ou fora do formato: o mesmo 401 de chave desconhecida, sem tocar no banco.
    if (key === undefined || !API_KEY_FORMAT.test(key)) throw unauthenticated();

    const tenant = await this.resolve(hashApiKey(key));
    if (!tenant) throw unauthenticated();

    // Autenticado: o tenant fica na requisição também quando o escopo falta (logs do 403).
    req.tenant = tenant;

    const required =
      this.reflector.getAllAndOverride<Scope[] | undefined>(REQUIRED_SCOPES_KEY, targets) ?? [];
    const missing = required.filter((scope) => !tenant.scopes.includes(scope));
    if (missing.length > 0) {
      throw new ForbiddenScopeError(`A chave não tem o escopo exigido: ${missing.join(", ")}`);
    }
    const anyOf = this.reflector.getAllAndOverride<Scope[] | undefined>(
      REQUIRED_ANY_SCOPES_KEY,
      targets,
    );
    if (anyOf !== undefined && !anyOf.some((scope) => tenant.scopes.includes(scope))) {
      throw new ForbiddenScopeError(
        `A chave precisa de ao menos um dos escopos: ${anyOf.join(", ")}`,
      );
    }
    return true;
  }

  private async resolve(hash: string): Promise<AuthTenant | undefined> {
    const rows = await this.prisma.$queryRaw<ResolvedKeyRow[]>`
      SELECT key_id, tenant_id, tenant_name, scopes, rpm, monthly_quota
      FROM resolve_api_key(${hash})`;
    const row = rows[0];
    if (!row) return undefined;
    return {
      keyId: row.key_id,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      // scopes NULL (coluna anulável) = nenhum escopo; nunca "todos".
      scopes: Array.isArray(row.scopes) ? row.scopes.filter((s) => typeof s === "string") : [],
      rpm: row.rpm,
      monthlyQuota: row.monthly_quota,
    };
  }
}

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const tenant = context.switchToHttp().getRequest<AuthenticatedRequest>().tenant;
    // Rota @Public(): sem tenant, sem contexto (o TenantPrismaService falha fechado).
    if (!tenant) return next.handle();

    return new Observable<unknown>((subscriber) => {
      let unsubscribe: (() => void) | undefined;
      let closed = false;
      // `next.handle()` é chamado e assinado DENTRO do run: o Nest liga o handler ao contexto
      // assíncrono do momento de `handle()`, e tudo o que o handler aguardar herda o tenant.
      TenantContext.run(
        { tenantId: tenant.tenantId, keyId: tenant.keyId, scopes: tenant.scopes },
        () =>
          new Promise<void>((done) => {
            if (closed) return done();
            const sub = next.handle().subscribe({
              next: (value) => subscriber.next(value),
              error: (err: unknown) => {
                subscriber.error(err);
                done();
              },
              complete: () => {
                subscriber.complete();
                done();
              },
            });
            unsubscribe = () => {
              sub.unsubscribe();
              done();
            };
          }),
      ).catch((err: unknown) => subscriber.error(err));
      return () => {
        closed = true;
        unsubscribe?.();
      };
    });
  }
}
