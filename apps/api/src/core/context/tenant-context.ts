/**
 * Contexto do tenant (e, opcionalmente, do cliente final) da requisição ou do job em curso.
 *
 * Guardado em AsyncLocalStorage: acompanha a cadeia de awaits de quem chamou `run` e some quando
 * ela termina, sem vazar para requisições concorrentes. O TenantPrismaService lê daqui o
 * tenant/cliente que fixa em `app.tenant_id`/`app.client_id` antes de cada consulta (RLS).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { UnauthenticatedError, ValidationError } from "../errors/domain-errors.js";

export interface TenantCtx {
  readonly tenantId: string;
  readonly clientId?: string;
  readonly keyId?: string;
  readonly scopes?: readonly string[];
}

export interface TenantCtxInput {
  tenantId: string;
  clientId?: string;
  keyId?: string;
  scopes?: string[];
}

// Forma canônica (com hífens), qualquer versão: é o que o Postgres devolve e o que gravamos.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(field: string, value: string): void {
  if (!UUID_RE.test(value)) throw new ValidationError(`${field} precisa ser um uuid`);
}

const storage = new AsyncLocalStorage<TenantCtx>();

/**
 * Executa `fn` e espera o resultado DENTRO do escopo de `ctx`. Necessário porque as promises do
 * Prisma são preguiçosas: a consulta (e a leitura do contexto pela extensão) só acontece no
 * `.then`. Se `fn` devolvesse a PrismaPromise e o `.then` fosse chamado por quem espera, fora do
 * `storage.run`, a consulta rodaria no contexto de fora (sem tenant, ou sem o cliente de
 * `withClient`).
 */
function runIn<T>(ctx: TenantCtx, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, async () => await fn());
}

/** Valida os ids e devolve uma cópia congelada (ninguém altera o contexto depois de fixado). */
function freeze(input: TenantCtxInput): TenantCtx {
  assertUuid("tenantId", input.tenantId);
  if (input.clientId !== undefined) assertUuid("clientId", input.clientId);
  if (input.keyId !== undefined) assertUuid("keyId", input.keyId);
  return Object.freeze({
    tenantId: input.tenantId,
    ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    ...(input.keyId !== undefined ? { keyId: input.keyId } : {}),
    ...(input.scopes !== undefined ? { scopes: Object.freeze([...input.scopes]) } : {}),
  });
}

export const TenantContext = {
  /** Roda `fn` com o contexto fixado. Ids inválidos rejeitam com ValidationError. */
  async run<T>(ctx: TenantCtxInput, fn: () => Promise<T>): Promise<T> {
    return runIn(freeze(ctx), fn);
  },

  /** Contexto atual; lança UnauthenticatedError fora de `run` (falha fechada). */
  current(): TenantCtx {
    const ctx = storage.getStore();
    if (!ctx) throw new UnauthenticatedError("Sem contexto de tenant");
    return ctx;
  },

  /** Herda o contexto atual (tenant, chave, escopos) e fixa o cliente final. */
  async withClient<T>(clientId: string, fn: () => Promise<T>): Promise<T> {
    const { tenantId, keyId, scopes } = TenantContext.current();
    return runIn(
      freeze({
        tenantId,
        clientId,
        ...(keyId !== undefined ? { keyId } : {}),
        ...(scopes !== undefined ? { scopes: [...scopes] } : {}),
      }),
      fn,
    );
  },
};
