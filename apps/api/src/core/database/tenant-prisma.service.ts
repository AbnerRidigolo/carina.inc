/**
 * Prisma com o contexto de tenant aplicado pelo Postgres (Row-Level Security).
 *
 * As políticas leem `app.tenant_id`/`app.client_id` (ver migrations/0002_rls). Cada operação de
 * modelo de `client` roda numa transação em batch que primeiro fixa os dois valores com
 * `set_config(nome, valor, true)` (local à transação: some no COMMIT/ROLLBACK, e a conexão volta
 * ao pool sem contexto) e depois executa a consulta. Valores sempre como parâmetros.
 *
 * - Sem TenantContext: UnauthenticatedError antes de qualquer SQL.
 * - Sem clientId: `app.client_id` = '' (NULL para as políticas): tabelas com cliente opcional
 *   mostram todos os clientes do tenant; as tabelas kg_* (cliente obrigatório) não mostram nada.
 * - Para várias operações atômicas ou SQL bruto parametrizado, use `tx()`. `client` não expõe
 *   `$transaction` nem `$queryRaw`/`$executeRaw`: ali o contexto não seria aplicado.
 */
import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { TenantContext, type TenantCtx } from "../context/tenant-context.js";
import { PrismaService } from "./prisma.service.js";

type SqlRunner = Pick<PrismaClient, "$executeRaw">;

/** `SELECT set_config($1, $2, true)` para tenant e cliente; '' quando não há cliente. */
function setContext(db: SqlRunner, ctx: TenantCtx) {
  return [
    db.$executeRaw`SELECT set_config(${"app.tenant_id"}, ${ctx.tenantId}, true)`,
    db.$executeRaw`SELECT set_config(${"app.client_id"}, ${ctx.clientId ?? ""}, true)`,
  ] as const;
}

function extend(base: PrismaClient) {
  return base.$extends({
    name: "tenant-rls",
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const ctx = TenantContext.current();
          const [, , result] = await base.$transaction([...setContext(base, ctx), query(args)]);
          return result;
        },
      },
    },
  });
}

type ExtendedClient = ReturnType<typeof extend>;

/** Membros que executariam SQL fora da transação com contexto. */
type Unscoped =
  | "$transaction"
  | "$queryRaw"
  | "$executeRaw"
  | "$queryRawUnsafe"
  | "$executeRawUnsafe"
  | "$extends";

export type TenantPrismaClient = Omit<ExtendedClient, Unscoped>;

export interface TxOptions {
  isolation?: "ReadCommitted" | "Serializable";
}

@Injectable()
export class TenantPrismaService {
  readonly client: TenantPrismaClient;

  constructor(@Inject(PrismaService) private readonly base: PrismaClient) {
    this.client = extend(base);
  }

  /**
   * Transação interativa com o contexto atual fixado antes de `fn`. Roda no cliente bruto (o
   * `tx` não passa pela extensão): todo o trabalho de `fn` usa a mesma conexão e o mesmo contexto.
   * O contexto é lido uma vez, na entrada: `withClient` dentro de `fn` não muda o `tx`.
   */
  async tx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, opts?: TxOptions): Promise<T> {
    const ctx = TenantContext.current();
    return this.base.$transaction(
      async (tx) => {
        for (const statement of setContext(tx, ctx)) await statement;
        return fn(tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel[opts?.isolation ?? "ReadCommitted"] },
    );
  }
}
