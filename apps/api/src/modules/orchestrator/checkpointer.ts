/**
 * Checkpointer do LangGraph no Postgres (schema `langgraph`).
 *
 * As tabelas NÃO são criadas pela aplicação: a migração `0005_langgraph_checkpoints` (escrita à
 * mão, roda como carina_migrator) cria as tabelas na forma da versão fixada de
 * `@langchain/langgraph-checkpoint-postgres` e registra as versões em `checkpoint_migrations`. O
 * `PostgresSaver.setup()` original roda `CREATE SCHEMA IF NOT EXISTS`, que exige CREATE no BANCO,
 * e o carina_app (NOSUPERUSER, sem CREATE no banco) não tem; DDL em runtime também não é desejável.
 * Por isso `setup()` aqui só CONFERE que a migração está aplicada (falha no boot, com instrução).
 *
 * Sem RLS: o isolamento é o prefixo `tenantId:clientId:` do thread (ver thread-id.ts).
 */
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";
import type { Env } from "../../core/config/env.js";

export const CHECKPOINT_SCHEMA = "langgraph";
/**
 * Última versão de migração da biblioteca fixada (índice em `getMigrations`, v0..v5). Ao subir a
 * versão da biblioteca, conferir as migrações novas e escrever a migração Prisma correspondente;
 * o teste de paridade (test/orchestrator/orchestrator.int.spec.ts) compara o resultado com o `setup()` original.
 */
export const CHECKPOINT_MIGRATION_VERSION = 5;

export interface CheckpointerLogger {
  error(fields: { msg: string; err?: unknown }): void;
}

export class CarinaCheckpointer extends PostgresSaver {
  constructor(private readonly checkpointPool: pg.Pool) {
    super(checkpointPool, undefined, { schema: CHECKPOINT_SCHEMA });
  }

  /** Confere (sem DDL) que as tabelas de checkpoint estão na versão esperada. */
  override async setup(): Promise<void> {
    let version: number | undefined;
    try {
      const { rows } = await this.checkpointPool.query<{ v: number | null }>(
        `SELECT max(v) AS v FROM ${CHECKPOINT_SCHEMA}.checkpoint_migrations`,
      );
      version = rows[0]?.v ?? undefined;
    } catch (err) {
      if ((err as { code?: string }).code !== "42P01") throw err;
    }
    if (version !== CHECKPOINT_MIGRATION_VERSION) {
      throw new Error(
        `Tabelas de checkpoint do LangGraph ausentes ou em outra versão (esperada ` +
          `${CHECKPOINT_MIGRATION_VERSION}, encontrada ${version ?? "nenhuma"}): rode ` +
          "`prisma migrate deploy` (migração 0005_langgraph_checkpoints).",
      );
    }
  }
}

export function createCheckpointer(
  env: Pick<Env, "DATABASE_URL">,
  logger: CheckpointerLogger,
): CarinaCheckpointer {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  // Sem handler, um erro numa conexão ociosa derruba o processo.
  pool.on("error", (err) => {
    logger.error({ msg: "Erro numa conexão ociosa do pool de checkpoints", err });
  });
  return new CarinaCheckpointer(pool);
}
