/**
 * Global setup dos testes de integração e E2E.
 *
 * - Com TEST_DATABASE_URL (superusuário; CI com service container ou Postgres local): cria um banco
 *   novo `carina_test_<pid>_<projeto>`, cria os papéis que faltarem (docker/postgres/roles.sql;
 *   papéis existentes nunca são alterados, e a senha deles precisa bater com
 *   CARINA_MIGRATOR_PASSWORD/CARINA_APP_PASSWORD, padrão igual ao do .env.example), cria a
 *   extensão vector e roda `prisma migrate deploy` como carina_migrator. O banco é removido no
 *   teardown.
 * - Sem TEST_DATABASE_URL: sobe `pgvector/pgvector:pg17` via Testcontainers e faz o mesmo.
 * - Com TEST_REDIS_URL usa esse Redis; sem ele, sobe `redis:7-alpine`.
 *
 * - TEST_DB_ICU_LOCALE (opcional, ex.: `en-US`; só vale com TEST_DATABASE_URL): cria o banco com
 *   LOCALE_PROVIDER icu e esse ICU_LOCALE (PostgreSQL >= 15), para rodar as suítes sob uma
 *   collation que não seja a binária C (o CI usa en_US.utf8 e ordena texto de outro jeito que
 *   um Postgres local em C.UTF-8). Sem a variável nada muda. O caminho Testcontainers (sem
 *   TEST_DATABASE_URL) ignora a variável. O valor é validado (letras, dígitos, `-` e `_`)
 *   porque CREATE DATABASE não aceita parâmetros.
 *
 * Os testes recebem TEST_DATABASE_URL_APP, TEST_DATABASE_URL_MIGRATOR e TEST_REDIS_URL por
 * `inject()` (ver test/setup/db.ts).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    TEST_DATABASE_URL_APP: string;
    TEST_DATABASE_URL_MIGRATOR: string;
    TEST_REDIS_URL: string;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, "../..");
const rolesSqlPath = resolve(apiRoot, "../../docker/postgres/roles.sql");

// Papéis são do cluster inteiro e podem já existir (ex.: o Postgres do docker compose, usado
// também pelo dev). O harness usa as mesmas senhas do compose/.env.example, só cria papéis que
// faltam e NUNCA altera os existentes; se a senha não bater, falha com instruções.
const MIGRATOR_PASSWORD = process.env["CARINA_MIGRATOR_PASSWORD"] || "carina_migrator_dev";
const APP_PASSWORD = process.env["CARINA_APP_PASSWORD"] || "carina_app_dev";

/** Confere que o papel entra com a senha configurada, sem tocar no papel. */
async function assertRoleLogin(url: string, role: string, envVar: string): Promise<void> {
  try {
    await withClient(url, async () => undefined);
  } catch (err) {
    const code = (err as { code?: string }).code;
    const reason = code === "28P01" ? "a senha não confere" : `erro ${code ?? String(err)}`;
    throw new Error(
      `Não foi possível conectar como ${role} (${reason}). O papel já existe no cluster de ` +
        `TEST_DATABASE_URL e o harness não altera papéis existentes: defina ${envVar} com a ` +
        `senha atual do papel (a mesma do seu .env/docker compose).`,
      { cause: err },
    );
  }
}

/** Lê roles.sql e troca os placeholders do psql (`:'var'`) por literais escapados pelo driver. */
export function renderRolesSql(
  client: pg.Client,
  vars: { migrator_pw: string; app_pw: string },
): string {
  let sql = readFileSync(rolesSqlPath, "utf8");
  for (const [name, value] of Object.entries(vars)) {
    const placeholder = `:'${name}'`;
    if (!sql.includes(placeholder)) throw new Error(`roles.sql sem o placeholder ${placeholder}`);
    sql = sql.replaceAll(placeholder, client.escapeLiteral(value));
  }
  if (/:'\w+'/.test(sql)) throw new Error("roles.sql tem placeholders psql sem valor");
  return sql;
}

function withCredentials(base: string, user: string, password: string, database: string): string {
  const url = new URL(base);
  url.username = encodeURIComponent(user);
  url.password = encodeURIComponent(password);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const ICU_LOCALE_PATTERN = /^[A-Za-z0-9_-]{2,32}$/;

/** Valida TEST_DB_ICU_LOCALE: vai direto no SQL (CREATE DATABASE não tem bind parameters). */
export function parseIcuLocale(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!ICU_LOCALE_PATTERN.test(raw)) {
    throw new Error(
      `TEST_DB_ICU_LOCALE inválido (${JSON.stringify(raw)}): use só letras, dígitos, "-" e "_" ` +
        "(2 a 32 caracteres), ex.: en-US.",
    );
  }
  return raw;
}

async function createDatabaseSql(c: pg.Client, ident: string, icuLocale?: string) {
  if (!icuLocale) return `CREATE DATABASE ${ident} OWNER carina_migrator`;
  const { rows } = await c.query<{ major: number }>(
    "SELECT current_setting('server_version_num')::int / 10000 AS major",
  );
  const major = rows[0]?.major ?? 0;
  if (major < 15) {
    throw new Error(
      `TEST_DB_ICU_LOCALE exige PostgreSQL >= 15 (LOCALE_PROVIDER icu); o servidor é ${major}. ` +
        "Remova a variável ou use um servidor mais novo.",
    );
  }
  return (
    `CREATE DATABASE ${ident} OWNER carina_migrator TEMPLATE template0 ENCODING 'UTF8' ` +
    `LOCALE_PROVIDER icu ICU_LOCALE '${icuLocale}' LOCALE 'C.UTF-8'`
  );
}

async function bootstrapDatabase(superuserUrl: string, database: string, icuLocale?: string) {
  await withClient(superuserUrl, async (c) => {
    await c.query(renderRolesSql(c, { migrator_pw: MIGRATOR_PASSWORD, app_pw: APP_PASSWORD }));
    const ident = c.escapeIdentifier(database);
    await c.query(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`);
    await c.query(await createDatabaseSql(c, ident, icuLocale));
  });
  // Extensão não confiável: criada pelo superusuário, dentro do banco novo.
  await withClient(withDatabase(superuserUrl, database), (c) =>
    c.query("CREATE EXTENSION IF NOT EXISTS vector"),
  );

  const migratorUrl = withCredentials(superuserUrl, "carina_migrator", MIGRATOR_PASSWORD, database);
  const appUrl = withCredentials(superuserUrl, "carina_app", APP_PASSWORD, database);
  await assertRoleLogin(migratorUrl, "carina_migrator", "CARINA_MIGRATOR_PASSWORD");
  await assertRoleLogin(appUrl, "carina_app", "CARINA_APP_PASSWORD");

  try {
    execFileSync(resolve(apiRoot, "node_modules/.bin/prisma"), ["migrate", "deploy"], {
      cwd: apiRoot,
      env: { ...process.env, MIGRATION_DATABASE_URL: migratorUrl, CHECKPOINT_DISABLE: "1" },
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (err) {
    const { stdout, stderr } = err as { stdout?: string; stderr?: string };
    throw new Error(`prisma migrate deploy falhou:\n${stdout ?? ""}\n${stderr ?? ""}`, {
      cause: err,
    });
  }

  return { migratorUrl, appUrl };
}

function withDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

export default async function setup(project: TestProject) {
  const teardowns: (() => Promise<void>)[] = [];
  // int e e2e podem rodar no mesmo processo: o nome do projeto separa os bancos.
  const database = `carina_test_${process.pid}_${project.name.replace(/\W/g, "_")}`;

  try {
    let superuserUrl = process.env["TEST_DATABASE_URL"];
    // Só vale no caminho TEST_DATABASE_URL (ver o comentário no topo do arquivo).
    const icuLocale = superuserUrl ? parseIcuLocale(process.env["TEST_DB_ICU_LOCALE"]) : undefined;
    if (!superuserUrl) {
      const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
      const container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
        .withUsername("postgres")
        .withPassword("postgres")
        .withDatabase("postgres")
        .start();
      teardowns.push(async () => {
        await container.stop();
      });
      superuserUrl = container.getConnectionUri();
    }

    let redisUrl = process.env["TEST_REDIS_URL"];
    if (!redisUrl) {
      const { GenericContainer, Wait } = await import("testcontainers");
      const redis = await new GenericContainer("redis:7-alpine")
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
        .start();
      teardowns.push(async () => {
        await redis.stop();
      });
      redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    }

    const admin = superuserUrl;
    // Registrado antes do bootstrap, para limpar o banco mesmo se ele falhar no meio; roda antes
    // de parar o container (teardowns em ordem reversa).
    teardowns.push(async () => {
      await withClient(admin, (c) =>
        c.query(`DROP DATABASE IF EXISTS ${c.escapeIdentifier(database)} WITH (FORCE)`),
      );
    });
    const { migratorUrl, appUrl } = await bootstrapDatabase(admin, database, icuLocale);

    project.provide("TEST_DATABASE_URL_APP", appUrl);
    project.provide("TEST_DATABASE_URL_MIGRATOR", migratorUrl);
    project.provide("TEST_REDIS_URL", redisUrl);
  } catch (err) {
    await runTeardowns(teardowns);
    throw err;
  }

  return () => runTeardowns(teardowns);
}

async function runTeardowns(teardowns: (() => Promise<void>)[]) {
  for (const teardown of teardowns.reverse()) await teardown();
}
