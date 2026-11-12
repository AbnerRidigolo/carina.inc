/**
 * Id determinístico da solicitação de aprovação: `sha256(threadId|action|stableStringify(payload))`.
 *
 * Determinístico porque o nó executor roda de novo ao retomar o grafo: o mesmo pedido gera o mesmo
 * id e o upsert é idempotente. `threadId` (`tenantId:clientId:uuid`) não contém `|`; o
 * InboxService.request valida esse formato, o que também impede colisão entre tenants.
 */
import { createHash } from "node:crypto";

/**
 * JSON com as chaves dos objetos ordenadas recursivamente (ordem de código UTF-16, sem collation).
 * Mesma semântica de `JSON.stringify` para valores sem representação (undefined em objeto é
 * omitido, em array vira null) e para `toJSON`.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const withJson = value as { toJSON?: () => unknown };
  if (typeof withJson.toJSON === "function") return sortKeys(withJson.toJSON());
  if (Array.isArray(value)) return value.map(sortKeys);
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}

export function approvalId(threadId: string, action: string, payload: unknown): string {
  return createHash("sha256")
    .update(`${threadId}|${action}|${stableStringify(payload)}`, "utf8")
    .digest("hex");
}
