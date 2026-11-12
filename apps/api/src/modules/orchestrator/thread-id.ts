/**
 * Ids de thread do orquestrador: `tenantId:clientId:<id>` (o mesmo formato que o
 * `InboxService.request` valida).
 *
 * As tabelas de checkpoint (schema `langgraph`) NÃO têm RLS: o isolamento entre tenants é o prefixo
 * do thread. Toda leitura, escrita ou retomada de um thread passa por `assertThreadInContext`, que
 * exige que o tenant E o cliente do thread sejam os do `TenantContext` atual; um thread de outro
 * tenant/cliente é tratado como inexistente (NotFoundError, sem revelar que existe).
 */
import { TenantContext, type TenantCtx } from "../../core/context/tenant-context.js";
import { NotFoundError, ValidationError } from "../../core/errors/domain-errors.js";

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const THREAD_ID_RE = new RegExp(`^(${UUID}):(${UUID}):([A-Za-z0-9_-]{1,128})$`);

export interface ThreadIds {
  tenantId: string;
  clientId: string;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function parseThreadId(threadId: unknown): ThreadIds | undefined {
  if (typeof threadId !== "string") return undefined;
  const m = THREAD_ID_RE.exec(threadId);
  if (!m || m[1] === undefined || m[2] === undefined) return undefined;
  return { tenantId: m[1], clientId: m[2] };
}

function belongsTo(ids: ThreadIds, ctx: TenantCtx): boolean {
  return (
    same(ids.tenantId, ctx.tenantId) &&
    ctx.clientId !== undefined &&
    same(ids.clientId, ctx.clientId)
  );
}

/** Valida o formato e a posse do thread pelo contexto atual (tenant e cliente). */
export function assertThreadInContext(threadId: unknown): ThreadIds {
  const ctx = TenantContext.current();
  if (ctx.clientId === undefined) {
    throw new ValidationError("O orquestrador precisa do cliente final no contexto");
  }
  const ids = parseThreadId(threadId);
  if (!ids) throw new ValidationError("threadId precisa ser tenantId:clientId:<id>");
  if (!belongsTo(ids, ctx)) throw new NotFoundError("Thread não encontrado");
  return ids;
}

function ambient(): TenantCtx | undefined {
  try {
    return TenantContext.current();
  } catch {
    return undefined;
  }
}

/**
 * Roda `fn` (um nó do grafo) com o TenantContext do tenant e do cliente do thread. Se houver um
 * contexto ambiente, ele precisa ser o mesmo do thread (senão NotFoundError): um nó nunca roda
 * com o contexto de um tenant sobre o thread de outro.
 */
export function runInThread<T>(threadId: unknown, fn: () => Promise<T>): Promise<T> {
  const ids = parseThreadId(threadId);
  if (!ids) return Promise.reject(new ValidationError("threadId inválido no grafo"));
  const ctx = ambient();
  if (ctx && !same(ctx.tenantId, ids.tenantId)) {
    return Promise.reject(new NotFoundError("Thread não encontrado"));
  }
  if (ctx?.clientId !== undefined && !same(ctx.clientId, ids.clientId)) {
    return Promise.reject(new NotFoundError("Thread não encontrado"));
  }
  return TenantContext.run(
    {
      tenantId: ids.tenantId,
      clientId: ids.clientId,
      ...(ctx?.keyId !== undefined ? { keyId: ctx.keyId } : {}),
      ...(ctx?.scopes !== undefined ? { scopes: [...ctx.scopes] } : {}),
    },
    fn,
  );
}
