/**
 * Alocação dos DBs lógicos do Redis (0–15) entre os arquivos de teste de integração e E2E.
 *
 * Vários arquivos esvaziam o DB (`flushdb`) ou consomem o stream `jobs` dele: dois arquivos no
 * mesmo DB rodando em paralelo apagariam o estado um do outro. Por isso cada arquivo tem o seu.
 *
 * São 16 DBs para mais de 16 arquivos, então a unicidade vale DENTRO de cada projeto do vitest
 * (`int`, `e2e`). Os projetos nunca rodam ao mesmo tempo: `sequence.groupOrder` no
 * vitest.config.ts faz `unit` → `int` → `e2e` em sequência mesmo numa execução única (ex.: a de
 * cobertura). Fixado por test/setup/redis-dbs.int.spec.ts: números únicos por projeto, e todo
 * arquivo que usa um DB do Redis o pega daqui pelo próprio caminho.
 *
 * Chave: caminho do arquivo relativo a `apps/api/test/`.
 *
 * Os 16 DBs do projeto `int` já estão tomados. Um arquivo novo pode DIVIDIR o DB de outro do
 * mesmo projeto (SHARED_REDIS_DBS, abaixo) só quando nenhum dos dois esvazia o DB (`flushdb`/
 * `flushall`) nem consome grupos do stream `jobs`, e cada um só apaga as chaves que são suas.
 * Fixado pelo mesmo redis-dbs.int.spec.ts.
 */
export const REDIS_DBS = {
  int: {
    "seed/seed.int.spec.ts": 0,
    "app/app-graph.int.spec.ts": 1,
    "orchestrator/resume.int.spec.ts": 2,
    "orchestrator/orchestrator.int.spec.ts": 3,
    "agents/agents.int.spec.ts": 4,
    "inbox/inbox.int.spec.ts": 5,
    "market/market-service.int.spec.ts": 6,
    "market/market-core.int.spec.ts": 10,
    "redis/lock.int.spec.ts": 7,
    "data-ingestion/sync.int.spec.ts": 8,
    "data-ingestion/ingestion.int.spec.ts": 9,
    "redis/streams.int.spec.ts": 11,
    "limits/limits.int.spec.ts": 12,
    "llm/provider-limiter.int.spec.ts": 13,
    "knowledge/knowledge.int.spec.ts": 14,
    "imports/imports.int.spec.ts": 15,
  },
  e2e: {
    "chat/chat.e2e.spec.ts": 1,
    "routes/route-scopes.e2e.spec.ts": 2,
    "flow/full-flow.e2e.spec.ts": 3,
    "health/health.e2e.spec.ts": 4,
    "inbox/decision.e2e.spec.ts": 5,
    "chat/ws.e2e.spec.ts": 6,
    "tenancy/clients.e2e.spec.ts": 10,
    "watchtower/watchtower.e2e.spec.ts": 12,
    "billing/billing.e2e.spec.ts": 13,
    "data-ingestion/ingestion.e2e.spec.ts": 15,
    "imports/imports.e2e.spec.ts": 7,
    "market/market.e2e.spec.ts": 0,
    "evaluation/evaluation.e2e.spec.ts": 9,
    "builder/builder.e2e.spec.ts": 11,
    "aops/aops.e2e.spec.ts": 14,
    "monitor/monitor.e2e.spec.ts": 8,
  },
} as const satisfies Record<"int" | "e2e", Record<string, number>>;

/**
 * Arquivo → arquivo dono do DB que ele divide (mesmo projeto). Regras no topo do arquivo.
 * - monitor/monitor.int.spec.ts divide com app/app-graph.int.spec.ts, que não lê nem grava
 *   chaves (o `consume` dele é um no-op); o monitor só apaga `monitor:*` e `market:*` e filtra
 *   `inbox.events` pelos próprios tenants.
 * - aops/aop-run.int.spec.ts divide com app/app-graph.int.spec.ts pelo mesmo motivo; chama o
 *   handler do AopJob direto (não consome `jobs`) e só apaga `aops:*` e as chaves de cota dos
 *   próprios tenants.
 */
export const SHARED_REDIS_DBS = {
  int: {
    "monitor/monitor.int.spec.ts": "app/app-graph.int.spec.ts",
    "aops/aop-run.int.spec.ts": "app/app-graph.int.spec.ts",
  },
  e2e: {},
} as const satisfies {
  int: Record<string, keyof (typeof REDIS_DBS)["int"]>;
  e2e: Record<string, keyof (typeof REDIS_DBS)["e2e"]>;
};

type AllocatedFile =
  | keyof (typeof REDIS_DBS)["int"]
  | keyof (typeof REDIS_DBS)["e2e"]
  | keyof (typeof SHARED_REDIS_DBS)["int"]
  | keyof (typeof SHARED_REDIS_DBS)["e2e"];

/** DB lógico do Redis reservado para o arquivo de teste (caminho relativo a `apps/api/test/`). */
export function redisDbOf(file: AllocatedFile): number {
  const shared: Record<string, string> = { ...SHARED_REDIS_DBS.int, ...SHARED_REDIS_DBS.e2e };
  const owner = shared[file] ?? file;
  const db =
    (REDIS_DBS.int as Record<string, number>)[owner] ??
    (REDIS_DBS.e2e as Record<string, number>)[owner];
  if (db === undefined) throw new Error(`Arquivo sem DB do Redis alocado: ${file}`);
  return db;
}
