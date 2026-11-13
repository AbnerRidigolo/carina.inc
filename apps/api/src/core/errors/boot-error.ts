/**
 * Texto de uma falha de boot para o stderr (main.ts, main.worker.ts, seed). Antes do pino existir
 * (ex.: Env inválido) ou depois de o Nest desistir, o stderr é o único registro: vai a stack
 * completa e a cadeia de `cause` (ex.: o ECONNREFUSED por trás de um erro de conexão), não só a
 * mensagem. As mensagens do loadEnv listam nomes de variáveis inválidas, nunca valores.
 */
const MAX_CAUSES = 5;

export function formatBootError(err: unknown): string {
  if (!(err instanceof Error)) {
    if (typeof err === "string") return err;
    try {
      return JSON.stringify(err) ?? String(err);
    } catch {
      return String(err);
    }
  }
  const parts = [err.stack ?? `${err.name}: ${err.message}`];
  const seen = new Set<unknown>([err]);
  let cause: unknown = err.cause;
  for (let i = 0; i < MAX_CAUSES && cause !== undefined && !seen.has(cause); i++) {
    seen.add(cause);
    parts.push(
      `Caused by: ${cause instanceof Error ? (cause.stack ?? `${cause.name}: ${cause.message}`) : String(cause)}`,
    );
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return parts.join("\n");
}
