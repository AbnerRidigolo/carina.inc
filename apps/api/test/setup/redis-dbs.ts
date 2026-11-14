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
    "market/market.e2e.spec.ts": 0,
  },
} as const satisfies Record<"int" | "e2e", Record<string, number>>;

type AllocatedFile = keyof (typeof REDIS_DBS)["int"] | keyof (typeof REDIS_DBS)["e2e"];

/** DB lógico do Redis reservado para o arquivo de teste (caminho relativo a `apps/api/test/`). */
export function redisDbOf(file: AllocatedFile): number {
  const db =
    (REDIS_DBS.int as Record<string, number>)[file] ??
    (REDIS_DBS.e2e as Record<string, number>)[file];
  if (db === undefined) throw new Error(`Arquivo sem DB do Redis alocado: ${file}`);
  return db;
}
