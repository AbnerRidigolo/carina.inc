/**
 * Acesso ao banco de teste criado pelo global-setup.
 *
 * O carina_migrator é o dono das tabelas, mas as tabelas de dados têm FORCE ROW LEVEL SECURITY:
 * o dono também passa pelas políticas. Para preparar dados em tabelas com RLS, passe `ctx` e o
 * comando roda numa transação com `app.tenant_id`/`app.client_id` fixados (set_config local).
 */
import pg from "pg";
import { inject } from "vitest";

export interface RlsContext {
  tenantId?: string;
  clientId?: string;
}

/** URL do papel de runtime (carina_app: NOSUPERUSER NOBYPASSRLS). */
export function appUrl(): string {
  return inject("TEST_DATABASE_URL_APP");
}

/** URL do papel dono (carina_migrator). */
export function migratorUrl(): string {
  return inject("TEST_DATABASE_URL_MIGRATOR");
}

export function redisUrl(): string {
  return inject("TEST_REDIS_URL");
}

/** Abre uma conexão nova, roda `fn` e fecha a conexão. */
export async function withPgClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Roda `fn` numa transação com o contexto de RLS fixado só para ela (set_config local). */
export async function inRlsTransaction<T>(
  client: pg.Client,
  ctx: RlsContext,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.client_id', $2, true)",
      [ctx.tenantId ?? "", ctx.clientId ?? ""],
    );
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/** Executa SQL como carina_migrator, para os testes prepararem dados como dono. */
export async function migratorSql<R extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: unknown[],
  ctx?: RlsContext,
): Promise<R[]> {
  return withPgClient(migratorUrl(), async (c) => {
    const run = async () => (await c.query<R>(sql, params)).rows;
    return ctx ? inRlsTransaction(c, ctx, run) : run();
  });
}
