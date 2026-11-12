/**
 * Prisma com o contexto de tenant aplicado pelo Postgres (Row-Level Security).
 *
 * As políticas leem `app.tenant_id`/`app.client_id` (ver migrations/0002_rls). Cada operação de
 * modelo de `client` roda numa transação em batch que primeiro fixa os dois valores com
 * `set_config(nome, valor, true)` (local à transação: some no COMMIT/ROLLBACK, e a conexão volta
 * ao pool sem contexto) e depois executa a consulta. Valores sempre como parâmetros.
 *
 * O contexto é capturado NA CHAMADA do método do modelo, não quando a promise é esperada: as
 * promises do Prisma são preguiçosas, e ler o contexto no `.then` faria a consulta rodar no
 * contexto de quem espera (ex.: consultas criadas em `withClient(A1)` e esperadas fora dele
 * veriam todos os clientes do tenant; uma promise compartilhada rodaria no tenant de outra
 * requisição). Por isso cada método devolve uma Promise nativa, já em execução.
 *
 * - Sem TenantContext na chamada: a promise rejeita com UnauthenticatedError, sem SQL.
 * - Sem clientId: `app.client_id` = '' (NULL para as políticas): tabelas com cliente opcional
 *   mostram todos os clientes do tenant; as tabelas kg_* (cliente obrigatório) não mostram nada.
 * - `client` expõe só os modelos. Para várias operações atômicas ou SQL bruto parametrizado, use
 *   `tx()`; `$transaction`/`$queryRaw`/`$executeRaw` não existem em `client`.
 * - A API fluente de relações (`findUnique(...).posicoes()`) não é suportada: o retorno é uma
 *   Promise nativa, e a chamada falha com TypeError. Use `include`/`select`.
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

/** Chave do delegate de cada modelo no cliente (`KgChunk` → `kgChunk`). */
type ModelKey = Uncapitalize<Prisma.ModelName>;

const modelKeys = Object.values(Prisma.ModelName).map(
  (name) => (name.charAt(0).toLowerCase() + name.slice(1)) as ModelKey,
);

/** Os delegates dos modelos; cada método roda com o contexto capturado na chamada. */
export type TenantPrismaClient = Pick<PrismaClient, ModelKey>;

type Method = (...args: unknown[]) => Prisma.PrismaPromise<unknown>;

/**
 * Envolve um delegate do cliente bruto: cada método lê `TenantContext.current()` de forma
 * síncrona, na chamada, e já dispara a transação em batch com esse contexto.
 */
function bindDelegate(base: PrismaClient, delegate: object): object {
  const cache = new Map<PropertyKey, unknown>();
  return new Proxy(delegate, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      let bound = cache.get(prop);
      if (!bound) {
        const method = value as Method;
        // async: o corpo até o primeiro await roda já na chamada (captura o contexto agora), e
        // qualquer erro vira rejeição.
        bound = async (...args: unknown[]) => {
          const ctx = TenantContext.current();
          const query = method.apply(target, args);
          const [, , result] = await base.$transaction([...setContext(base, ctx), query]);
          return result;
        };
        cache.set(prop, bound);
      }
      return bound;
    },
    set() {
      return false;
    },
  });
}

function bindClient(base: PrismaClient): TenantPrismaClient {
  const client: Partial<Record<ModelKey, object>> = {};
  for (const key of modelKeys) client[key] = bindDelegate(base, base[key]);
  return Object.freeze(client) as TenantPrismaClient;
}

export interface TxOptions {
  isolation?: "ReadCommitted" | "Serializable";
}

@Injectable()
export class TenantPrismaService {
  readonly client: TenantPrismaClient;

  constructor(@Inject(PrismaService) private readonly base: PrismaClient) {
    this.client = bindClient(base);
  }

  /**
   * Ids dos tenants que têm trabalho pendente na inbox (aprovação pending, approved sem execução
   * ou execução started), via `active_tenant_ids()` (SECURITY DEFINER, migrations/0004). Roda como
   * carina_app, sem contexto de tenant e sem dar o papel migrator à aplicação: devolve só ids, e só
   * de tenants com linha não terminal. Cada tenant é processado depois sob `TenantContext.run`.
   */
  async activeTenantIds(): Promise<string[]> {
    const rows = await this.base.$queryRaw<{ active_tenant_ids: string }[]>`
      SELECT active_tenant_ids() AS active_tenant_ids`;
    return rows.map((r) => r.active_tenant_ids);
  }

  /**
   * Transação interativa com o contexto atual fixado antes de `fn`. O contexto é lido na chamada
   * (corpo síncrono do método async); `withClient` dentro de `fn` não muda o `tx`. Todo o
   * trabalho de `fn` usa a mesma conexão e o mesmo contexto.
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
