# CARINA TypeScript — Fase 1 (núcleo apresentável) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar o monorepo TypeScript do CARINA com o fluxo completo funcionando por `docker compose up` sem chaves de API: dados sintéticos → chat com agentes em paralelo e streaming → ação irreversível pausada → aprovação → execução única, cobrada e auditada.

**Architecture:** Monorepo pnpm com `apps/api` (NestJS 12, ESM), `apps/web` (React + Vite) e `packages/shared` (schemas Zod). Postgres 17 + pgvector guarda dados transacionais, conhecimento e checkpoints do LangGraph, com isolamento por RLS. Redis faz cache, limites e Streams. O orquestrador é um grafo LangGraph.js sobre modelos LangChain.js com reserva automática e um modo mock determinístico.

**Tech Stack:** Node ≥ 22.12, pnpm 10, TypeScript strict, NestJS 12 (`@nestjs/platform-ws`, `@nestjs/schedule`), Prisma 7, PostgreSQL 17 + pgvector, Redis 7 (`ioredis`), `@langchain/langgraph` 1.x, `@langchain/langgraph-checkpoint-postgres` 1.x, `@langchain/core` 1.x, `@langchain/openai` (OpenRouter e NVIDIA via `baseURL`), `@langchain/groq`, Zod, `nestjs-zod`, `nestjs-pino`, Vitest, Supertest, Testcontainers, React 19, Vite, TanStack Query, Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-11-migracao-typescript-design.md`

## Global Constraints

- Node `>=22.12`; `"type": "module"` em todos os pacotes; TypeScript `strict: true`, `noUncheckedIndexedAccess: true`.
- Versões exatas fixadas no `pnpm-lock.yaml`; `pnpm install --frozen-lockfile` no CI.
- Imagens: `pgvector/pgvector:pg17` e `redis:7-alpine`. O código deve funcionar também em Postgres 16 com pgvector (ambiente local de desenvolvimento).
- Dinheiro sempre `numeric(18,2)` / `Prisma.Decimal` / string decimal nos contratos JSON; nunca `number` para valores em R$.
- Embeddings: `vector(1024)`.
- Prefixo HTTP global `/api`; WebSocket em `/ws/chat`.
- Erros HTTP em RFC 9457 (`application/problem+json`) com `traceId`; nunca expor mensagem interna.
- Mapeamento: validação 422 · sem chave/chave inválida 401 · sem escopo 403 · recurso de outro tenant 404 · conflito de decisão 409 · limite/cota 429 com `Retry-After` · todos os provedores falharam 503 com `Retry-After`.
- Escopos de chave: `chat`, `inbox:decide`, `data:write`, `admin`.
- Preços (R$) por `WorkType`: `query` 1.50 · `analysis` 7.50 · `multi_agent_analysis` 15.00 · `optimization` 30.00 · `execution` 75.00 · `data_query` 0.05 · `data_ingestion` 0.05 · `evaluation` 5.00 · `backtest` 7.50. Fee de execução: `EXECUTION_FEE_PCT=0.5` (% sobre `value_brl`), arredondado a 2 casas.
- Defaults de limite: `DEFAULT_RPM=60`; `monthly_quota=0` significa ilimitado.
- Streams: `inbox.events`, `notifications`, `jobs`; `XREADGROUP BLOCK 5000`; `XAUTOCLAIM` após 60 s; DLQ `<stream>.dlq` após 5 entregas; dedup `SET dedup:<stream>:<eventId> NX EX 86400`.
- Ticket de WebSocket: uso único, 30 s, chave Redis `ws:ticket:<ticket>`.
- Histórico do thread cortado nas últimas 20 mensagens antes de cada chamada de modelo.
- `thread_id` = `${tenantId}:${clientId}:${uuid}` (ids internos uuid).
- Execução: `executed_action` preso em `started` > 5 min vira `needs_review` e nunca é reexecutado; reconciliação a cada 1 min; `resume` republicado para aprovações `approved` sem `executed_action` após 2 min.
- Limitador por provedor de LLM: 20 req/min (valor `litellm.rpm` do `models.yaml`).
- Lotes de ingestão: até 1.000 itens.
- O LLM nunca gera SQL; toda consulta é parametrizada.
- `LLM_MODE=mock` faz toda a aplicação funcionar sem nenhuma chave externa.

## Review Focus

1. **Client id desconhecido ou de outro tenant nas rotas `/clients/:clientId/...`** → deve responder 404 (nunca 500, nunca dados de outro tenant). Teste em Task 7 (`clients.e2e.spec.ts`).
2. **Mensagem de chat vazia, enorme (> 8.000 caracteres) ou só espaços** → 422 antes de reservar cota. Teste em Task 20.
3. **Decisão em solicitação expirada ou já decidida, e decisão dupla simultânea** → 409 e exatamente uma execução. Teste em Task 16.
4. **Provedor de LLM fora do ar no meio do stream** → evento `error` com `code` e `traceId`, cota devolvida, nada cobrado. Teste em Task 20.
5. **Lote de ingestão com itens repetidos dentro do mesmo lote e valores com mais de 2 casas decimais** → upsert sem duplicar; valores rejeitados com 422 apontando o índice do item. Teste em Task 13.

## Decisões de implementação (detalhes que o spec deixa abertos)

- **Executor depois da síntese.** O spec desenha `executor → interrupt → synthesize`. O plano usa `… → synthesize → executor`. Assim a resposta chega ao usuário antes da pausa, e a retomada só executa a ação. O cliente recebe `done` com `status: "awaiting_approval"`.
- **Ingestão de documentos sem extração por LLM na fase 1.** `ingestDocument` recebe entidades e relações já prontas, opcionalmente; o Sync as gera deterministicamente. A extração por LLM fica para o Researcher, na fase 2.
- **Tabela extra `kg_mention(tenant_id, client_id, chunk_id, entity_id)`** liga chunks a entidades, o que a busca híbrida precisa ("entidades citadas nesses chunks").
- **`audit_event`** também guarda `agents text[]`, `response_digest` (sha256 da resposta, sem o texto) e `duration_ms`, como no Python.
- **TTL de aprovação:** `APPROVAL_TTL_HOURS=24`.
- **Embeddings mock** por feature hashing de tokens (dá similaridade lexical real na demo; ver Task 11).
- **OpenRouter e NVIDIA via `ChatOpenAI`/`OpenAIEmbeddings` com `baseURL`.** Evita o pacote `@langchain/openrouter`, que ainda é beta.
- **Testes de integração** usam `TEST_DATABASE_URL` e `TEST_REDIS_URL` quando definidos (CI com service containers, ou Postgres e Redis locais). Sem elas, sobem Testcontainers.

---

## Estrutura de arquivos

```
package.json · pnpm-workspace.yaml · tsconfig.base.json · eslint.config.js · .prettierrc
docker-compose.yml · docker/postgres/init.sql · .env.example
.github/workflows/ci.yml                (job "legacy-python" + job "typescript")
legacy/python/                          (todo o Python atual, movido)
packages/shared/src/
  index.ts · money.ts · problem.ts · chat.ts · inbox.ts · billing.ts · audit.ts · ingestion.ts · agents.ts
apps/api/
  Dockerfile · package.json · tsconfig.json · vitest.config.ts
  config/models.yaml
  prisma/schema.prisma · prisma/migrations/0001_init/migration.sql · prisma/migrations/0002_rls/migration.sql
  src/main.ts · src/main.worker.ts · src/app.module.ts · src/worker.module.ts
  src/core/config/{env.ts, models-config.ts, config.module.ts}
  src/core/logging/logging.module.ts
  src/core/errors/{domain-errors.ts, problem-details.filter.ts}
  src/core/context/tenant-context.ts
  src/core/database/{prisma.service.ts, tenant-prisma.service.ts, database.module.ts}
  src/core/redis/{redis.module.ts, cache.service.ts, streams.service.ts}
  src/modules/tenancy/{api-key.ts, api-key.guard.ts, scopes.decorator.ts, current-tenant.decorator.ts, clients.service.ts, clients.controller.ts, tenancy.module.ts}
  src/modules/limits/{rate-limit.guard.ts, quota.service.ts, sliding-window.lua.ts, limits.module.ts}
  src/modules/billing/{pricing.ts, billing.service.ts, billing.controller.ts, billing.module.ts}
  src/modules/watchtower/{inspect-text.ts, watchtower.service.ts, watchtower.controller.ts, watchtower.module.ts}
  src/modules/llm/{model-factory.ts, provider-limiter.ts, mock-models.ts, hash-embeddings.ts, llm.module.ts}
  src/modules/knowledge/{chunker.ts, knowledge.repository.ts, knowledge.service.ts, knowledge.module.ts}
  src/modules/data-ingestion/{provider.ts, ingestion.repository.ts, ingestion.controller.ts, ingestion.service.ts, synthetic/generator.ts, synthetic/profiles.ts, sync.worker.ts, data-ingestion.module.ts}
  src/modules/inbox/{risk.ts, approval-id.ts, executors.ts, inbox.service.ts, inbox.controller.ts, reconciliation.job.ts, inbox.module.ts}
  src/modules/agents/{agent.ts, prompts.ts, navigator.ts, insight.ts, predictor.ts, risk.ts, executor.ts, mock-responders.ts, agents.module.ts}
  src/modules/orchestrator/{state.ts, heuristic.ts, graph.ts, checkpointer.ts, orchestrator.service.ts, resume.worker.ts, orchestrator.module.ts}
  src/modules/chat/{chat.controller.ts, chat.service.ts, ws-ticket.service.ts, chat.gateway.ts, inbox-broadcast.ts, chat.module.ts}
  src/modules/health/health.controller.ts
  src/seed/seed.ts
  test/setup/{global-setup.ts, app.ts, db.ts}
  test/**/*.int.spec.ts · test/**/*.e2e.spec.ts
apps/web/
  Dockerfile · package.json · vite.config.ts · index.html
  src/{main.tsx, App.tsx, api/client.ts, api/ws.ts, state/session.ts}
  src/features/{connect/ConnectScreen.tsx, chat/ChatView.tsx, chat/AgentCard.tsx, inbox/InboxPanel.tsx, usage/UsagePanel.tsx, portfolio/PortfolioPanel.tsx}
  src/**/*.test.tsx
README.md · docs/ARCHITECTURE.md (reescrito)
```

Testes unitários ficam ao lado do código (`*.spec.ts`); integração em `apps/api/test/**/*.int.spec.ts`; E2E em `apps/api/test/**/*.e2e.spec.ts`. Scripts do `apps/api`: `test:unit`, `test:int`, `test:e2e`, cada um um projeto Vitest.

---

### Task 1: Monorepo, legado Python e CI

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `.nvmrc` (`22.12`), `packages/shared/{package.json,tsconfig.json,src/index.ts,src/index.spec.ts}`, `apps/api/{package.json,tsconfig.json,vitest.config.ts}`, `apps/web/{package.json,tsconfig.json}`
- Move: `carina/ modal_jobs/ frontend/ deployment/ scripts/ tests/ pyproject.toml .env.example` → `legacy/python/` (com `git mv`)
- Modify: `.github/workflows/ci.yml`, `.gitignore`

**Interfaces:**
- Produces: scripts na raiz `pnpm lint`, `pnpm typecheck`, `pnpm test` (unit de todos), `pnpm build`; pacote `@carina/shared` importável por `api` e `web`.

- [ ] **Step 1:** `git mv` dos itens Python para `legacy/python/` e um `legacy/python/README.md` de uma linha ("código Python original, removido na fase 3"). Rodar `cd legacy/python && pip install -e ".[dev]" && ruff check carina tests modal_jobs && pytest -m "not integration" -q`. Esperado: `All checks passed!` e `138 passed`.
- [ ] **Step 2:** Criar o workspace pnpm (`packages/*`, `apps/*`), o `tsconfig.base.json` com as opções das Global Constraints, ESLint flat config com `typescript-eslint` strict e Prettier (printWidth 100).
- [ ] **Step 3: Teste de fumaça do shared**

```ts
// packages/shared/src/index.spec.ts
import { SHARED_VERSION } from "./index.js";
it("exporta a versão do contrato", () => expect(SHARED_VERSION).toBe("1"));
```

- [ ] **Step 4:** Rodar `pnpm test`. Esperado: FAIL ("SHARED_VERSION is not exported"). Implementar `export const SHARED_VERSION = "1"` e rodar de novo. Esperado: PASS.
- [ ] **Step 5:** Reescrever o `ci.yml` com dois jobs:
  - `legacy-python`: os passos atuais com `working-directory: legacy/python`.
  - `typescript`: Node 22.12, `pnpm/action-setup`, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Service containers `pgvector/pgvector:pg17` e `redis:7-alpine` expostos via `TEST_DATABASE_URL`/`TEST_REDIS_URL`, usados a partir da Task 4 por `pnpm --filter api test:int` e `test:e2e`, que entram no job quando existirem.
- [ ] **Step 6:** Rodar `pnpm lint && pnpm typecheck && pnpm build`. Esperado: tudo verde.
- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: monorepo pnpm, Python movido para legacy/ e CI com dois jobs"
```

---

### Task 2: Contratos compartilhados (`packages/shared`)

**Files:**
- Create: `packages/shared/src/{money.ts,problem.ts,chat.ts,inbox.ts,billing.ts,audit.ts,ingestion.ts,agents.ts}` e um `*.spec.ts` para cada.
- Modify: `packages/shared/src/index.ts` (reexporta tudo)

**Interfaces:**
- Produces (todos com o schema Zod `XSchema` e o tipo `X = z.infer<typeof XSchema>`):
  - `MoneySchema`: string decimal com no máximo 2 casas, regex `^-?\d{1,16}(\.\d{1,2})?$`.
  - `ProblemSchema`: `{ type, title, status, detail?, traceId }`.
  - `WorkTypeSchema`: enum dos 9 work types das Global Constraints.
  - `SpecialistNameSchema`: `"insight" | "predictor" | "risk"`.
  - `AgentNameSchema`: `SpecialistName | "navigator" | "executor"`.
  - `PlanSchema`: `{ complexity: "simples" | "média" | "complexa", agents: SpecialistName[], wantsExecution: boolean, rationale: string }`.
  - `CashFlowScenarioSchema`: `{ name, horizonMonths: int 12–36, assumptions: string[], projectedNetFlowBrl: Money, confidence: 0–1 }`.
  - `CashFlowForecastSchema`: `{ scenarios: CashFlowScenario[] (min 1), narrative }`.
  - `RiskAssessmentSchema`: `{ driftPct: number, valueAtRiskBrl: Money, topCorrelations: string[], stressFindings: string[], rebalanceSuggestions: string[] }`.
  - `ActionProposalSchema`: `{ action: string, payload: Record<string, unknown>, valueBrl: Money, rationale: string }`.
  - `RiskClassSchema`: `"read" | "reversible" | "irreversible"`.
  - `ChatRequestSchema`: `{ clientId: string 1–64 [A-Za-z0-9_-], message: string trim 1–8000, threadId?: string }`.
  - `ChatEventSchema`: union discriminada por `type`:
    - `plan { plan }`
    - `agent_started { agent }`
    - `token { agent, text }`
    - `agent_result { agent, result: unknown }`
    - `approval_required { approval: ApprovalView }`
    - `approval_executed { approvalId, status, result?: unknown }`
    - `done { threadId, status: "completed" | "awaiting_approval", answer: string, usage: { workType, priceBrl: Money }, compliance: { auditId, flags: ComplianceFlag[] } }`
    - `error { code: string, traceId: string }`
  - `ApprovalViewSchema`: `{ id, clientId (externalId), agent, action, risk, payload, valueBrl: Money, status: "pending" | "approved" | "rejected" | "expired", expiresAt: ISO, createdAt: ISO }`.
  - `DecisionRequestSchema`: `{ approved: boolean, reason?: string max 500 }`.
  - `ComplianceFlagSchema`: `{ code, severity: "info" | "warning" | "violation", detail }`.
  - `UsageSummarySchema`: `{ month: "YYYY-MM", resolutions: int, totalBrl: Money, byWorkType: Record<WorkType, { count, totalBrl }> }`.
  - `AuditEventViewSchema`: `{ id, clientId?, channel, query, agents, flags, durationMs, createdAt }`.
  - `NormalizedPositionSchema`: `{ externalId 1–128, institution, kind: "investment" | "cash", assetClass: "acao" | "fii" | "tesouro" | "renda_fixa" | "fundo" | "caixa", assetCode?: string, name, quantity?: string decimal ≤8 casas, valueBrl: Money, asOf: ISO date }`.
  - `NormalizedTransactionSchema`: `{ externalId 1–128, institution, account, date: ISO date, description, amountBrl: Money, kind: "debit" | "credit" | "buy" | "sell" | "dividend" | "jcp" | "fee" | "tax", category?: string, assetCode?: string, quantity?: string decimal }`.
  - `PositionBatchSchema` / `TransactionBatchSchema`: `{ items: [...] }` com 1–1000 itens.
  - `StreamEventSchema`: union por `type`:
    - `approval.created { tenantId, clientId, approvalId }`
    - `approval.executed { tenantId, clientId, approvalId, status }`
    - `resume { tenantId, clientId, approvalId, threadId, approved }`
    - `data.ingested { tenantId, clientId, source }`
    - `notification { tenantId, clientId, kind, text }`
    - todos com `eventId: uuid`.

- [ ] **Step 1: Testes que falham**, um por arquivo. Exemplos que fixam as regras:

```ts
expect(MoneySchema.safeParse("1234.56").success).toBe(true);
expect(MoneySchema.safeParse("1.234").success).toBe(false);
expect(MoneySchema.safeParse(10).success).toBe(false);
expect(ChatRequestSchema.safeParse({ clientId: "c1", message: "   " }).success).toBe(false);
expect(ChatRequestSchema.safeParse({ clientId: "a__b/../x", message: "oi" }).success).toBe(false);
expect(PositionBatchSchema.safeParse({ items: [] }).success).toBe(false);
expect(PositionBatchSchema.safeParse({ items: Array(1001).fill(validPosition) }).success).toBe(false);
expect(ChatEventSchema.parse({ type: "error", code: "llm_unavailable", traceId: "t" }).type).toBe("error");
expect(CashFlowScenarioSchema.safeParse({ ...scenario, horizonMonths: 48 }).success).toBe(false);
```

- [ ] **Step 2:** `pnpm --filter @carina/shared test`. Esperado: FAIL (módulos inexistentes).
- [ ] **Step 3:** Implementar os schemas acima. Sem dependências além de `zod`.
- [ ] **Step 4:** `pnpm --filter @carina/shared test`. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(shared): contratos Zod de chat, inbox, billing, auditoria e ingestão`

---

### Task 3: Configuração, logs e erros RFC 9457

**Files:**
- Create: `apps/api/src/core/config/{env.ts,models-config.ts,config.module.ts}` e specs; `apps/api/config/models.yaml`; `apps/api/src/core/logging/logging.module.ts`; `apps/api/src/core/errors/{domain-errors.ts,problem-details.filter.ts}` e specs; `.env.example` na raiz.

**Interfaces:**
- Produces:
  - `loadEnv(raw: NodeJS.ProcessEnv): Env`. O schema Zod exige:
    - `NODE_ENV`, `PORT` (default 3000);
    - `DATABASE_URL` (papel `carina_app`), `MIGRATION_DATABASE_URL` (papel `carina_migrator`), `REDIS_URL`;
    - `LLM_MODE: "live" | "mock"` (default `"mock"`);
    - `OPENROUTER_API_KEY?`, `GROQ_API_KEY?`, `NVIDIA_API_KEY?`;
    - `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`), `GROQ_BASE_URL` (default `https://api.groq.com/openai/v1`), `NVIDIA_BASE_URL` (default `https://integrate.api.nvidia.com/v1`);
    - `EXECUTION_FEE_PCT` (default 0.5), `DEFAULT_RPM` (default 60), `APPROVAL_TTL_HOURS` (default 24), `WEB_ORIGIN` (default `http://localhost:5173`).

    Com `LLM_MODE=live`, falta de `OPENROUTER_API_KEY` derruba o boot.
  - `loadModelsConfig(path: string): ModelsConfig`, com `roles: Record<"conversational" | "reasoning", { primary: string, fallback: string[] }>`, `embeddings: { primary: string, dimensions: 1024 }` e `limits: { rpm: number, timeoutMs: number, temperature: number }`.
  - `ConfigModule` exporta os tokens `ENV` e `MODELS_CONFIG`.
  - Erros em `domain-errors.ts`, todos estendendo `DomainError { code, status, retryAfterSeconds? }`:

    | Erro | Status |
    |---|---|
    | `ValidationError` | 422 |
    | `UnauthenticatedError` | 401 |
    | `ForbiddenScopeError` | 403 |
    | `NotFoundError` | 404 |
    | `ApprovalConflictError` | 409 |
    | `RateLimitedError` | 429 |
    | `QuotaExceededError` | 429 |
    | `AllProvidersFailedError` | 503, `retryAfterSeconds` 30 |

  - `ProblemDetailsFilter`: filtro global que converte `DomainError`, `ZodValidationException` (422) e `HttpException` em `Problem`. Qualquer outro erro vira 500 com `title: "Erro interno"` e sem `detail`. Sempre com `traceId`, vindo do `req.id` do pino.

- [ ] **Step 1:** Copiar o conteúdo de `legacy/python/carina/config/models.yaml` para `apps/api/config/models.yaml`, renomeando a seção `litellm` para `limits` (`rpm: 20`, `timeoutMs: 60000`, `temperature: 0.2`) e removendo `max_retries`.
- [ ] **Step 2: Testes que falham**:
  - `env.spec.ts`: `loadEnv({...min, LLM_MODE: "live"})` sem `OPENROUTER_API_KEY` lança erro citando `OPENROUTER_API_KEY`; o default de `LLM_MODE` é `"mock"`.
  - `models-config.spec.ts`: carregar o `models.yaml` real dá `roles.reasoning.fallback.length === 2` e `embeddings.dimensions === 1024`.
  - `problem-details.filter.spec.ts` (chamando o filtro com um `ArgumentsHost` falso):
    - `QuotaExceededError` gera status 429, header `Retry-After` e `content-type` `application/problem+json`;
    - `new Error("senha do banco xyz")` gera 500 cujo corpo não contém `"senha"`.
- [ ] **Step 3:** Rodar `pnpm --filter api test:unit`. Esperado: FAIL.
- [ ] **Step 4:** Implementar. O `LoggingModule` usa `nestjs-pino` com `genReqId` (uuid), redaction de `req.headers.authorization`, `req.headers["x-api-key"]`, `*.apiKey`, `*.cpf`, `*.email`, `*.phone`, e saída JSON.
- [ ] **Step 5:** Rodar `pnpm --filter api test:unit`. Esperado: PASS.
- [ ] **Step 6: Commit** `feat(api): config validada, logs com redaction e erros RFC 9457`

---

### Task 4: Banco — schema Prisma, migrações, papéis e harness de testes

**Files:**
- Create:
  - `docker-compose.yml`, só com os serviços `postgres` e `redis` nesta task; api e web entram na Task 21;
  - `docker/postgres/init.sql`;
  - `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/0001_init/migration.sql`, `apps/api/prisma/migrations/0002_rls/migration.sql`;
  - `apps/api/test/setup/{global-setup.ts,db.ts}`, `apps/api/test/database/migrations.int.spec.ts`.

**Interfaces:**
- Produces:
  - **Tabelas** (`@@map` em snake_case):
    - `tenant`, `api_key`, `client`, `approval_request`, `executed_action`, `usage_record`, `audit_event`, `position`, `transaction` e `import_job` (esta só criada; usada na fase 2), com os campos do spec §5.1 mais os da seção "Decisões de implementação";
    - `kg_document`, `kg_chunk`, `kg_entity`, `kg_relation` e `kg_mention`, do spec §5.2.
  - Colunas `vector(1024)` e `tsvector` como `Unsupported(...)`.
  - **Funções de teste:**
    - `test/setup/db.ts: migratorSql(sql: string, params?: unknown[])`, para os testes prepararem dados como dono;
    - `appUrl(): string`.
  - `global-setup.ts` exporta `TEST_DATABASE_URL_APP`, `TEST_DATABASE_URL_MIGRATOR` e `TEST_REDIS_URL` para os testes.

- [ ] **Step 1:** Escrever o `init.sql`: `CREATE ROLE carina_migrator LOGIN PASSWORD :'migrator_pw'` e `CREATE ROLE carina_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOBYPASSRLS`; banco `carina` com dono `carina_migrator`; `CREATE EXTENSION IF NOT EXISTS vector` (como superusuário). As senhas vêm de variáveis do compose.
- [ ] **Step 2:** Escrever o `schema.prisma` e gerar a `0001_init`, com:
  - FK composta `kg_relation (tenant_id, client_id, source_id/target_id) → kg_entity (tenant_id, client_id, id)`, o que exige `UNIQUE (tenant_id, client_id, id)` em `kg_entity`;
  - `kg_chunk.tsv` como `GENERATED ALWAYS AS (to_tsvector('portuguese', content)) STORED`;
  - índices HNSW `vector_cosine_ops` em `kg_chunk.embedding` e `kg_entity.embedding`, GIN em `tsv` e btree `(tenant_id, client_id)` em todas as tabelas `kg_*`, `position`, `transaction` e `approval_request`;
  - `UNIQUE (tenant_id, client_id, source, external_id)` em `position` e `transaction`.
- [ ] **Step 3:** Escrever a `0002_rls` (SQL puro):
  - Schema `langgraph`, com `GRANT USAGE, CREATE ON SCHEMA langgraph TO carina_app`.
  - Grants: `GRANT SELECT, INSERT, UPDATE, DELETE` nas tabelas para `carina_app`, **exceto** `usage_record` e `audit_event`, que recebem só `SELECT, INSERT`. Também `REVOKE ALL ON api_key FROM carina_app`.
  - `ALTER TABLE … ENABLE ROW LEVEL SECURITY; ALTER TABLE … FORCE ROW LEVEL SECURITY` em todas as tabelas, exceto `tenant` e `api_key`.
  - Políticas (copiar exatamente):

```sql
-- tenant atual (NULL quando não fixado → nenhuma linha)
CREATE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION app_client() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.client_id', true), '')::uuid $$;

-- por tenant: usage_record, audit_event
CREATE POLICY tenant_only ON usage_record USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
-- por cliente (client_id opcional): approval_request, executed_action, position, transaction, import_job
CREATE POLICY tenant_client ON position
  USING (tenant_id = app_tenant() AND (app_client() IS NULL OR client_id = app_client()))
  WITH CHECK (tenant_id = app_tenant() AND (app_client() IS NULL OR client_id = app_client()));
-- tabela client: mesma regra usando a coluna id no lugar de client_id
-- conhecimento (cliente obrigatório): kg_document, kg_chunk, kg_entity, kg_relation, kg_mention
CREATE POLICY tenant_client_strict ON kg_chunk
  USING (tenant_id = app_tenant() AND client_id = app_client())
  WITH CHECK (tenant_id = app_tenant() AND client_id = app_client());
```

  - Leitura de `tenant`: política `USING (id = app_tenant())`.
  - `resolve_api_key(p_hash text)` com `SECURITY DEFINER` e dono `carina_migrator`. Retorna `TABLE(key_id uuid, tenant_id uuid, tenant_name text, scopes text[], rpm int, monthly_quota int)`, filtrando `revoked_at IS NULL`, com `GRANT EXECUTE … TO carina_app` e `SET search_path = public`.
- [ ] **Step 4:** Escrever o `global-setup.ts`:
  - **Com `TEST_DATABASE_URL`/`TEST_REDIS_URL`:** cria um banco novo `carina_test_<pid>` e roda o `init.sql` adaptado.
  - **Sem elas:** sobe `pgvector/pgvector:pg17` e `redis:7-alpine` via Testcontainers.
  - Nos dois casos, aplica as migrações com `prisma migrate deploy` usando a URL do migrator.
- [ ] **Step 5: Teste de integração que falha** (`migrations.int.spec.ts`), conectado como `carina_app`:
  - `SELECT count(*) FROM position` sem `app.tenant_id` retorna 0, mesmo com uma linha inserida pelo migrator;
  - `UPDATE audit_event SET query = 'x'` falha com `permission denied`;
  - `SELECT * FROM api_key` falha com `permission denied`;
  - `SELECT * FROM resolve_api_key($hash)` devolve o tenant semeado pelo migrator;
  - inserir uma `kg_relation` cujo `source_id` é uma entidade de outro cliente falha por FK.
- [ ] **Step 6:** Rodar `pnpm --filter api test:int`. Esperado: primeiro FAIL; depois de implementar os passos acima, PASS.
- [ ] **Step 7: Commit** `feat(db): schema Prisma, migrações com RLS, papéis e harness de integração`

---

### Task 5: Contexto de tenant e Prisma com RLS

**Files:**
- Create: `apps/api/src/core/context/tenant-context.ts`, `apps/api/src/core/database/{prisma.service.ts,tenant-prisma.service.ts,database.module.ts}`, `apps/api/test/database/rls-isolation.int.spec.ts`

**Interfaces:**
- Produces:
  - `TenantContext.run<T>(ctx: { tenantId: string; clientId?: string; keyId?: string; scopes?: string[] }, fn: () => Promise<T>): Promise<T>`
  - `TenantContext.current(): TenantCtx`: lança `UnauthenticatedError` se não houver contexto.
  - `TenantContext.withClient<T>(clientId: string, fn)`: herda o tenant e fixa o cliente.
  - `TenantPrismaService.client`: Prisma estendido. Cada operação de modelo roda num `$transaction([set_config tenant, set_config client, query])` em batch.
  - `TenantPrismaService.tx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, opts?: { isolation?: "ReadCommitted" | "Serializable" }): Promise<T>`: transação interativa que fixa `app.tenant_id`/`app.client_id` com `SELECT set_config($1, $2, true)` antes de chamar `fn`.
  - `PrismaService`: cliente bruto do papel `carina_app`, usado **somente** por `resolve_api_key` (Task 7) e pela própria extensão.

- [ ] **Step 1: Testes de integração que falham**, com dois tenants e dois clientes semeados pelo migrator:
  - **`rls-isolation.int.spec.ts`:**
    - dentro de `TenantContext.run({tenantId: A})`, `client.position.findMany()` não retorna linhas de B;
    - `client.position.create({ data: { tenantId: B, ... } })` falha (violação do `WITH CHECK`);
    - dentro de `withClient(A1)`, `client.position.findMany()` não retorna linhas de A2;
    - fora de qualquer contexto, `client.position.findMany()` lança `UnauthenticatedError`;
    - `tx()` com dois `create` em sequência, o segundo lançando erro, não persiste o primeiro.
  - **Concorrência:** 20 `TenantContext.run` em paralelo, alternando tenants A e B, cada um lendo `position`. Nenhum lê dado do outro (prova que `set_config(..., true)` fica preso à transação).
- [ ] **Step 2:** Rodar `pnpm --filter api test:int -- rls-isolation`. Esperado: FAIL.
- [ ] **Step 3:** Implementar. O `TenantContext` usa `AsyncLocalStorage`; a extensão usa `$allModels.$allOperations`.
- [ ] **Step 4:** Rodar de novo. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(api): TenantContext e Prisma com RLS por transação`

---

### Task 6: Redis — cache e Streams

**Files:**
- Create: `apps/api/src/core/redis/{redis.module.ts,cache.service.ts,streams.service.ts}`, `apps/api/test/redis/streams.int.spec.ts`, `apps/api/src/core/redis/cache.service.spec.ts`

**Interfaces:**
- Produces:
  - `CacheService.getOrSet<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T>`
  - `StreamsService.publish(stream: StreamName, event: StreamEvent): Promise<string>`: valida com `StreamEventSchema`.
  - `StreamsService.consume(opts: { stream: StreamName; group: string; consumer: string; handler: (e: StreamEvent) => Promise<void>; signal: AbortSignal }): Promise<void>`. O ciclo:
    1. Cria o grupo com `MKSTREAM` se faltar.
    2. Lê com `XREADGROUP BLOCK 5000 COUNT 10`.
    3. Para cada evento, adquire `dedup:<stream>:<eventId>` com `SET NX EX 86400`; se já existir, só dá `XACK`.
    4. Em sucesso, `XACK`; em erro, apaga a chave de dedup e não dá ack.
    5. A cada ciclo, `XAUTOCLAIM` de pendentes há mais de 60000 ms; mensagens com `times_delivered >= 5` vão para `<stream>.dlq` com `{ event, error }` e recebem `XACK`.
  - `StreamsService.tail(stream: StreamName, onEvent: (e: StreamEvent) => void, signal: AbortSignal)`: `XREAD BLOCK 5000` a partir de `$`, sem grupo (broadcast; usado na Task 20).
  - `type StreamName = "inbox.events" | "notifications" | "jobs"`.

- [ ] **Step 1: Testes que falham** (`streams.int.spec.ts`):
  - um evento publicado chega ao handler uma vez e o `XPENDING` fica em 0;
  - um handler que lança erro na 1ª tentativa e funciona na 2ª (com o relógio do autoclaim reduzido via opção `claimIdleMs` para o teste) termina com uma chamada bem-sucedida;
  - um handler que sempre falha leva o evento para `jobs.dlq` depois de 5 entregas;
  - o mesmo `eventId` publicado duas vezes chama o handler uma só vez;
  - um evento inválido no `publish` lança `ValidationError`.
- [ ] **Step 2:** Rodar `pnpm --filter api test:int -- streams`. Esperado: FAIL.
- [ ] **Step 3:** Implementar com `ioredis`; `claimIdleMs` (default 60000) e `maxDeliveries` (default 5) são opções do construtor.
- [ ] **Step 4:** Rodar de novo. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(api): Redis cache e Streams com consumer groups, reclaim, DLQ e dedup`

---

### Task 7: Tenancy — chaves de API, escopos e clientes

**Files:**
- Create: `apps/api/src/modules/tenancy/{api-key.ts,api-key.guard.ts,scopes.decorator.ts,current-tenant.decorator.ts,clients.service.ts,clients.controller.ts,tenancy.module.ts}` com specs; `apps/api/test/setup/app.ts`; `apps/api/test/tenancy/clients.e2e.spec.ts`

**Interfaces:**
- Produces:
  - `generateApiKey(): { key: string; hash: string; prefix: string }`, com `key = "sk-live-" + 32` caracteres base62 (`crypto.randomBytes`), `hash = sha256 hex`, `prefix = key.slice(0, 12)`.
  - `hashApiKey(key: string): string`.
  - `ApiKeyGuard` (guard global, com exceção para as rotas `@Public()`):
    - lê `Authorization: Bearer` ou `X-API-Key`;
    - chama `resolve_api_key` pelo `PrismaService`;
    - preenche `req.tenant: AuthTenant` e envolve o handler em `TenantContext.run`. Como guards não envolvem o handler, a parte `run` é um interceptor global `TenantContextInterceptor`, no mesmo arquivo.
  - `AuthTenant = { keyId: string; tenantId: string; tenantName: string; scopes: string[]; rpm: number; monthlyQuota: number }`.
  - `@RequireScopes(...scopes: Scope[])`: o guard verifica e lança `ForbiddenScopeError`.
  - `@CurrentTenant()`: param decorator que devolve `AuthTenant`.
  - `@Public()`.
  - `ClientsService.resolve(externalId: string, opts?: { create?: boolean }): Promise<{ id: string; externalId: string }>`: upsert quando `create`, senão lança `NotFoundError`.
  - `ClientsService.list(): Promise<{ id; externalId; createdAt }[]>`.
  - `GET /api/clients`, com escopo `chat`, lista os clientes do tenant.
  - `test/setup/app.ts`: `createTestApp(): Promise<{ app: INestApplication; seedTenant(opts?): Promise<{ tenantId; keys: Record<"chat" | "approver" | "ingest", string> }> }>`.

- [ ] **Step 1: Testes que falham**:
  - **Unidade:** `hashApiKey(k)` tem 64 caracteres hex; duas chaves geradas são diferentes; o prefixo começa com `sk-live-`.
  - **`clients.e2e.spec.ts`:**
    - `GET /api/clients` sem chave → 401, corpo `application/problem+json`;
    - com chave revogada → 401;
    - com chave do tenant A → só os clientes de A;
    - `GET /api/clients/<externalId de B>/positions` com a chave de A → 404 (Review Focus 1);
    - chave sem o escopo `chat` em `GET /api/clients` → 403.
- [ ] **Step 2:** Rodar `pnpm --filter api test:unit && pnpm --filter api test:e2e -- clients`. Esperado: FAIL.
- [ ] **Step 3:** Implementar. O 404 cruzado vem de `ClientsService.resolve`, que roda sob RLS e não encontra o cliente de outro tenant. A rota `GET /clients/:clientId/positions` é criada aqui só com `resolve` + `position.findMany` (a Task 13 a completa).
- [ ] **Step 4:** Rodar de novo. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(api): chaves de API com hash, escopos, contexto de tenant e clientes`

---

### Task 8: Limites — taxa por minuto e cota mensal

**Files:**
- Create: `apps/api/src/modules/limits/{sliding-window.lua.ts,rate-limit.guard.ts,quota.service.ts,limits.module.ts}`, `apps/api/test/limits/limits.int.spec.ts`

**Interfaces:**
- Consumes: `AuthTenant` (Task 7), `RateLimitedError` e `QuotaExceededError` (Task 3).
- Produces:
  - `RateLimitGuard` (global, depois do `ApiKeyGuard`). Usa a chave `rl:<tenantId>`, janela de 60000 ms e limite `AuthTenant.rpm`; quando excedido, lança `RateLimitedError` com `retryAfterSeconds = ceil(ms até o mais antigo sair da janela / 1000)`.
  - `slidingWindowAcquire(redis, key, limit, windowMs, nowMs): Promise<{ allowed: boolean; retryAfterMs: number }>`. Script Lua atômico:
    1. `ZREMRANGEBYSCORE key 0 now-window`;
    2. se `ZCARD < limit`, faz `ZADD now member` e `PEXPIRE window`, e retorna 0;
    3. senão, retorna `oldestScore + window - now`.

    Reutilizado pela Task 11.
  - `QuotaService.reserve(tenant: AuthTenant): Promise<void>`. Chave `quota:<tenantId>:<YYYY-MM>` (fuso `America/Sao_Paulo`): faz `INCR`; se `monthlyQuota > 0` e o valor passou do limite, faz `DECR` e lança `QuotaExceededError` com `retryAfterSeconds` até o início do próximo mês. `EXPIRE` de 40 dias.
  - `QuotaService.refund(tenant: AuthTenant): Promise<void>`: `DECR`.

- [ ] **Step 1: Testes que falham**:
  - com `rpm` 3, a 4ª requisição em 1 s recebe 429 com `Retry-After` ≥ 1, e a requisição passa de novo depois de avançar o relógio, injetado via provider `CLOCK`;
  - 50 `reserve` concorrentes com cota 10 resultam em exatamente 10 sucessos;
  - `reserve` seguido de `refund` deixa o contador em 0;
  - cota 0 nunca bloqueia.
- [ ] **Step 2:** Rodar `pnpm --filter api test:int -- limits`. Esperado: FAIL.
- [ ] **Step 3:** Implementar. O relógio vem de um provider `CLOCK` (`() => number`), substituível nos testes.
- [ ] **Step 4:** Rodar de novo. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(api): rate limit por janela deslizante e cota mensal atômica no Redis`

---

### Task 9: Billing

**Files:**
- Create: `apps/api/src/modules/billing/{pricing.ts,pricing.spec.ts,billing.service.ts,billing.controller.ts,billing.module.ts}`, `apps/api/test/billing/billing.int.spec.ts`

**Interfaces:**
- Produces:
  - `PRICE_BRL: Record<WorkType, string>`: os valores das Global Constraints.
  - `classifyWork(agents: string[]): WorkType`. As regras, nesta ordem:
    1. qualquer agente em `{"tax", "tax_optimizer", "rebalancer"}` → `optimization`;
    2. lista vazia → `query`;
    3. um agente → `analysis`;
    4. dois ou mais → `multi_agent_analysis`.
  - `extractValueBrl(payload: Record<string, unknown>): Prisma.Decimal`: procura nas chaves `value_brl`, `valueBrl`, `amount`, `value`, `valor`, nessa ordem. Aceita número ou string decimal (exceto boolean) e devolve o valor absoluto; ausente ou inválido dá `0`.
  - `computeExecutionPrice(valueBrl: Decimal, feePct: number): { priceBrl: Decimal; feeBrl: Decimal }`, com `fee = round(value × feePct / 100, 2)` e `price = 75.00 + fee`.
  - `BillingService.record(input: { tx?: Prisma.TransactionClient; clientId?: string; workType: WorkType; agents: string[]; valueBrl?: Decimal; durationMs: number }): Promise<UsageRecordRow>`: usa o `tx` quando recebido, para a gravação atômica com a auditoria.
  - `BillingService.summary(month?: string): Promise<UsageSummary>`.
  - `GET /api/usage?month=YYYY-MM`.

- [ ] **Step 1: Testes que falham** (`pricing.spec.ts`). Portar os casos de `legacy/python/tests/test_b2b_metering.py`, mais:

```ts
expect(classifyWork(["insight", "rebalancer"])).toBe("optimization");
expect(classifyWork([])).toBe("query");
expect(classifyWork(["insight"])).toBe("analysis");
expect(classifyWork(["insight", "risk"])).toBe("multi_agent_analysis");
expect(extractValueBrl({ amount: -1500.5 }).toString()).toBe("1500.5");
expect(extractValueBrl({ value_brl: true }).toString()).toBe("0");
expect(computeExecutionPrice(new Decimal("100000"), 0.5)).toEqual({ priceBrl: new Decimal("575.00"), feeBrl: new Decimal("500.00") });
```

  Integração: `summary()` do tenant A ignora os registros de B; o total soma corretamente 3 registros (`query`, `analysis`, `execution` com fee).
- [ ] **Step 2:** Rodar `pnpm --filter api test:unit -- pricing && pnpm --filter api test:int -- billing`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar de novo. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(api): billing por resolução com fee de execução em Decimal`

---

### Task 10: Watchtower

**Files:**
- Create: `apps/api/src/modules/watchtower/{inspect-text.ts,inspect-text.spec.ts,watchtower.service.ts,watchtower.controller.ts,watchtower.module.ts}`, `apps/api/test/watchtower/watchtower.int.spec.ts`

**Interfaces:**
- Produces:
  - `inspectText(text: string): ComplianceFlag[]`. Portar **literalmente** as regex e regras de `legacy/python/carina/b2b/watchtower.py`, ou seja, os padrões `_CERTAINTY_PATTERNS`, `_RECOMMENDATION_PATTERNS`, `_PII_PATTERNS`, `_DISCLAIMER_TRIGGERS` e `_DISCLAIMER_MARKERS`, todos case-insensitive:
    - certeza → `suitability.certainty_claim` (violation, `detail` = trecho);
    - recomendação → `cvm.unauthorized_recommendation` (violation);
    - PII → `lgpd.pii_leak.<cpf | email>` (violation, sem o valor);
    - gatilho sem marcador → `suitability.missing_disclaimer` (warning).
  - `WatchtowerService.review(input: { tx?; clientId?; channel: "rest" | "ws" | "worker"; query: string; agents: string[]; responseText: string; durationMs: number }): Promise<{ auditId: string; flags: ComplianceFlag[] }>`: grava o `audit_event` com `response_digest = sha256(responseText)`.
  - `WatchtowerService.trail(limit: number): Promise<AuditEventView[]>`, com `limit` máximo de 500.
  - `GET /api/audit?limit=`.

- [ ] **Step 1: Testes que falham**. Portar os casos de `legacy/python/tests/test_b2b_watchtower.py`, mais:
  - `inspectText("O CPF dele é 123.456.789-09")` gera uma flag cujo `detail` não contém `"123.456"`;
  - `inspectText("Projeção de fluxo de caixa: estimativa com premissas")` não gera `missing_disclaimer`;
  - **integração:** `review()` grava um evento que `trail()` devolve; o `response_digest` tem 64 caracteres hex; o banco não contém o texto da resposta.
- [ ] **Step 2:** Rodar `pnpm --filter api test:unit -- inspect-text && pnpm --filter api test:int -- watchtower`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar de novo. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(api): Watchtower com regras de compliance portadas e trilha append-only`

---

### Task 11: Camada de modelos (LLM)

**Files:**
- Create: `apps/api/src/modules/llm/{model-factory.ts,model-factory.spec.ts,provider-limiter.ts,mock-models.ts,hash-embeddings.ts,hash-embeddings.spec.ts,llm.module.ts}`

**Interfaces:**
- Consumes: `ModelsConfig` e `Env` (Task 3); `slidingWindowAcquire` (Task 8).
- Produces:
  - `type Role = "conversational" | "reasoning"`.
  - `ModelFactory.chat(role: Role, opts?: { schema?: ZodType; tools?: StructuredTool[]; mockKey?: string }): Runnable<BaseMessage[], AIMessage | unknown>`. Para cada modelo da cadeia:
    1. cria o `ChatOpenAI` (`openrouter/...` e `nvidia_nim/...`) ou o `ChatGroq` (`groq/...`), com `maxRetries: 0` e `timeout`/`temperature` vindos de `limits`;
    2. aplica `withStructuredOutput(schema)` ou `bindTools(tools)`;
    3. envolve em `limited(provider)`, que chama `slidingWindowAcquire` na chave `llm:rl:<provider>` com `limits.rpm` e lança `ProviderRateLimitedError` (definido em `provider-limiter.ts`) quando cheio.

    Encadeia com `first.withFallbacks(rest)`. Se toda a cadeia falhar, converte em `AllProvidersFailedError`.
  - `ModelFactory.embeddings(): EmbeddingsInterface`: `OpenAIEmbeddings` com `baseURL` da NVIDIA e `dimensions: 1024`, ou `HashEmbeddings` no modo mock.
  - Com `LLM_MODE=mock`, `chat()` devolve `MockChatModel`.
  - `MockChatModel(responder: MockResponder)`, uma subclasse de `BaseChatModel`:
    - `type MockResponder = (input: { mockKey: string; messages: BaseMessage[] }) => string | object`;
    - quando há `schema`, valida o objeto devolvido pelo responder com o próprio schema;
    - faz streaming dividindo o texto em pedaços de 12 caracteres.

    O registro de responders por `mockKey` é preenchido pela Task 17.
  - `HashEmbeddings implements EmbeddingsInterface`: tokens em minúsculas, sem acentos (NFD + remoção de marcas) e `\p{L}\p{N}`; cada token soma 1 na posição `fnv1a32(token) % 1024`; o vetor final é normalizado em L2. Texto sem tokens dá o vetor zero com `[0] = 1`.

- [ ] **Step 1: Testes que falham**:
  - **`model-factory.spec.ts`** (modelos falsos injetados via `chainOverride` para testar a cadeia):
    - primário lança erro 429 e o fallback responde → o resultado vem do fallback;
    - todos falham → `AllProvidersFailedError`;
    - com `schema`, uma resposta inválida do mock lança `ValidationError`;
    - o limitador com rpm 2 faz a 3ª chamada pular para o próximo modelo da cadeia.
  - **`hash-embeddings.spec.ts`:**
    - `embedQuery("Ações da PETR4")` tem 1024 dimensões e norma 1 ± 1e-6;
    - `cos(embed("PETR4 petrobras"), embed("petrobras PETR4")) > 0.99`;
    - `cos(embed("PETR4"), embed("tesouro selic")) < 0.2`;
    - a mesma entrada dá o mesmo vetor.
- [ ] **Step 2:** Rodar `pnpm --filter api test:unit -- llm`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar de novo. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(api): ModelFactory com fallbacks, limitador por provedor e modo mock`

---

### Task 12: Conhecimento — ingestão e busca híbrida

**Files:**
- Create: `apps/api/src/modules/knowledge/{chunker.ts,chunker.spec.ts,knowledge.repository.ts,knowledge.service.ts,knowledge.module.ts}`, `apps/api/test/knowledge/knowledge.int.spec.ts`

**Interfaces:**
- Consumes: `TenantPrismaService.tx` (Task 5), `ModelFactory.embeddings()` (Task 11).
- Produces:
  - `chunkText(text: string, opts?: { maxChars?: number; overlap?: number }): string[]`: quebra por parágrafos, `maxChars` 800, sobreposição de 100 e nunca devolve chunk vazio.
  - `KnowledgeService.ingestDocument(input: { source: string; title: string; text: string; entities?: { type: string; name: string; properties?: object }[]; relations?: { sourceRef: string; targetRef: string; type: string }[]; mentions?: string[] }): Promise<{ documentId: string; chunkIds: string[] }>`. Comportamento:
    - roda sob `TenantContext` com cliente fixado;
    - é idempotente por `(source, title)`: reingerir substitui os chunks antigos;
    - `ref` é `"<type>:<name>"`;
    - as entidades são upsert por `(type, name)`;
    - o embedding da entidade é o de `"<type> <name>"`.
  - `KnowledgeService.search(query: string, opts?: { k?: number }): Promise<SearchResult>`, com `SearchResult = { chunks: { chunkId; documentId; title; content; score }[]; entities: { type; name; properties }[]; neighbors: { from: string; type: string; to: string }[] }`. O algoritmo, numa única `tx`:
    1. `SET LOCAL hnsw.iterative_scan = relaxed_order`. Se o pgvector instalado não reconhecer a opção, ignorar o erro uma única vez com `SAVEPOINT`.
    2. Busca top 8 por `embedding <=> $q` e top 8 por `ts_rank(tsv, websearch_to_tsquery('portuguese', $text))`.
    3. Combina com RRF `score = Σ 1/(60 + rank)` e fica com os `k` melhores (padrão 6).
    4. Busca as entidades de `kg_mention` desses chunks.
    5. Busca os vizinhos com `WITH RECURSIVE` até 2 saltos em `kg_relation`, limitados a 20.

- [ ] **Step 1: Testes que falham**:
  - **`chunker.spec.ts`:** um texto de 2.000 caracteres gera de 3 a 4 chunks; nenhum passa de 800 caracteres; um chunk termina com um trecho que começa o próximo.
  - **`knowledge.int.spec.ts`:**
    - depois de ingerir "Carteira: 500 ações PETR4 na XP", `search("PETR4")` traz esse chunk em primeiro e a entidade `ativo:PETR4`;
    - para o cliente A2 do mesmo tenant, `search` de um termo que só existe nos dados de A1 retorna `chunks: []` (spec §9);
    - reingerir o mesmo `(source, title)` não duplica chunks;
    - uma relação `ativo:PETR4 -[CUSTODIADO_EM]-> instituicao:XP` aparece em `neighbors`.
- [ ] **Step 2:** Rodar `pnpm --filter api test:unit -- chunker && pnpm --filter api test:int -- knowledge`. Esperado: FAIL.
- [ ] **Step 3:** Implementar o repositório com `tx.$queryRaw`/`$executeRaw` parametrizados. Vetores entram como texto `'[v1,...]'::vector`.
- [ ] **Step 4:** Rodar de novo. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(api): conhecimento com pgvector, full-text, RRF e vizinhança no grafo`

---

### Task 13: Ingestão de dados — interface e API

**Files:**
- Create: `apps/api/src/modules/data-ingestion/{provider.ts,ingestion.repository.ts,ingestion.service.ts,ingestion.controller.ts,data-ingestion.module.ts}`, `apps/api/test/data-ingestion/ingestion.e2e.spec.ts`
- Modify: `apps/api/src/modules/tenancy/clients.controller.ts` (a rota `GET /clients/:clientId/positions` passa a usar o `IngestionService`)

**Interfaces:**
- Consumes: `ClientsService.resolve` (Task 7), `BillingService.record` (Task 9), `StreamsService.publish` (Task 6).
- Produces:
  - `interface FinancialDataProvider { readonly source: "api" | "import" | "synthetic"; positions(input: { clientId: string }): AsyncIterable<NormalizedPosition>; transactions(input: { clientId: string }): AsyncIterable<NormalizedTransaction> }`, como no spec §6.4.
  - `IngestionService.upsertPositions(clientExternalId: string, source: Source, items: NormalizedPosition[]): Promise<{ upserted: number }>`: deduplica dentro do lote pelo `externalId` (o último vence) e faz upsert por `(tenant_id, client_id, source, external_id)` numa `tx`.
  - `IngestionService.upsertTransactions(...)`: mesma regra.
  - `IngestionService.listPositions(clientExternalId)` e `listTransactions(clientExternalId, opts?: { from?: string; to?: string; limit?: number ≤ 1000 })`.
  - Rotas:
    - `POST /api/clients/:clientId/positions` e `POST /api/clients/:clientId/transactions`: escopo `data:write`; o cliente é criado se não existir. Cada lote é cobrado como `data_ingestion` e publica `data.ingested` em `jobs` com `source: "api"`. Resposta `201 { upserted, usage: { workType, priceBrl } }`.
    - `GET /api/clients/:clientId/positions` e `GET /api/clients/:clientId/transactions`: escopo `chat`.

- [ ] **Step 1: Testes que falham** (`ingestion.e2e.spec.ts`):
  - enviar o mesmo lote de 3 posições duas vezes deixa 3 linhas (`GET` devolve 3);
  - um lote com o mesmo `externalId` repetido grava uma linha, com os dados do último item (Review Focus 5);
  - `valueBrl: "10.123"` → 422 com `detail` citando `items.0.valueBrl` (Review Focus 5);
  - 1.001 itens → 422;
  - uma chave sem `data:write` → 403;
  - cada `POST` cria um `usage_record` do tipo `data_ingestion` com R$ 0,05;
  - cada `POST` deixa um evento `data.ingested` em `jobs`.
- [ ] **Step 2:** Rodar `pnpm --filter api test:e2e -- ingestion`. Esperado: FAIL.
- [ ] **Step 3:** Implementar. A validação usa `nestjs-zod` com `PositionBatchSchema` e `TransactionBatchSchema`.
- [ ] **Step 4:** Rodar de novo. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(api): API de ingestão idempotente de posições e transações`

---

### Task 14: Gerador sintético

**Files:**
- Create: `apps/api/src/modules/data-ingestion/synthetic/{profiles.ts,generator.ts,generator.spec.ts}`

**Interfaces:**
- Produces:
  - `type Profile = "conservador" | "moderado" | "arrojado"`.
  - `generatePortfolio(profile: Profile, seed: number, asOf: string /* YYYY-MM-DD */): { positions: NormalizedPosition[]; transactions: NormalizedTransaction[] }`. É determinístico: usa PRNG `mulberry32(seed)` e nunca `Math.random`.
  - `SyntheticProvider implements FinancialDataProvider` (`source: "synthetic"`), construído com `{ profile, seed, asOf }`.
- **Regras dos perfis** (alocação alvo em % do patrimônio, com variação de ±3 p.p. pelo seed):

  | Perfil | Patrimônio | Renda fixa + Tesouro | Fundos | FIIs | Ações | Caixa |
  |---|---|---|---|---|---|---|
  | conservador | R$ 1.500.000 | 70 | 10 | 10 | 5 | 5 |
  | moderado | R$ 4.000.000 | 45 | 15 | 15 | 20 | 5 |
  | arrojado | R$ 12.000.000 | 20 | 10 | 15 | 50 | 5 |

  - **Ativos:** ações de `PETR4, VALE3, ITUB4, BBAS3, WEGE3, PRIO3`; FIIs de `HGLG11, KNRI11, MXRF11, XPML11`; Tesouro `Tesouro Selic 2029` e `Tesouro IPCA+ 2035`; renda fixa em CDB, LCI e LCA; instituições `XP, BTG, Itaú, Nubank`.
  - **Transações** (12 meses até `asOf`):
    - salário mensal de 1,5% do patrimônio;
    - 6 despesas recorrentes com categorias (moradia, saúde, educação, alimentação, transporte, lazer);
    - uma compra parcelada em 10x;
    - aportes mensais;
    - dividendos trimestrais das ações e rendimentos mensais dos FIIs.

- [ ] **Step 1: Testes que falham**:
  - o mesmo seed gera saída idêntica (deep equal) e seeds diferentes geram saídas diferentes;
  - a soma das posições do moderado fica dentro de ±5% de R$ 4.000.000;
  - o percentual de ações do arrojado fica entre 47% e 53%;
  - todo `valueBrl`/`amountBrl` passa no `MoneySchema`;
  - todo `externalId` é único dentro do resultado;
  - há exatamente 10 transações com `description` contendo `"parcela"`.
- [ ] **Step 2:** Rodar `pnpm --filter api test:unit -- generator`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar de novo. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(api): gerador sintético de carteiras brasileiras com seed`

---

### Task 15: Sync — dados de clientes para o conhecimento

**Files:**
- Create: `apps/api/src/modules/data-ingestion/sync.worker.ts`, `apps/api/test/data-ingestion/sync.int.spec.ts`

**Interfaces:**
- Consumes: `StreamsService.consume` (Task 6), `IngestionService.listPositions`/`listTransactions` (Task 13), `KnowledgeService.ingestDocument` (Task 12), `TenantContext.run` (Task 5).
- Produces:
  - `SyncWorker.syncClient(tenantId: string, clientId: string): Promise<{ documents: number }>`. Gera dois documentos determinísticos, de `source` `"sync"`, cada um com entidades e relações:
    - **`Carteira consolidada`:** uma linha por posição (`"500 PETR4 (ação) na XP: R$ 15.000,00"`), mais a alocação por classe em %. Entidades `ativo:<code ou name>`, `instituicao:<name>` e `classe:<assetClass>`; relações `CUSTODIADO_EM`, `DA_CLASSE` e `POSSUI` (de `cliente:self` para o ativo).
    - **`Fluxo de caixa 12 meses`:** totais mensais de entradas e saídas, top 5 categorias de despesa, recorrências detectadas (mesma descrição normalizada em ≥ 3 meses) e parcelamentos. Entidades `categoria:<nome>`.
  - O worker consome `jobs` (grupo `sync`) e reage a `data.ingested`, ignorando os outros tipos de evento.

- [ ] **Step 1: Testes que falham**:
  - depois de ingerir o portfólio sintético moderado e chamar `syncClient`, `KnowledgeService.search("PETR4")` traz o chunk da carteira;
  - `search("moradia")` traz o fluxo de caixa;
  - chamar `syncClient` duas vezes não duplica documentos;
  - publicar `data.ingested` faz o worker sincronizar (verificado por polling em `kg_document` com timeout de 10 s).
- [ ] **Step 2:** Rodar `pnpm --filter api test:int -- sync`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar de novo. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(api): Sync de posições e transações para o grafo de conhecimento`

---

### Task 16: Inbox — risco, solicitações, decisão e execução no máximo uma vez

**Files:**
- Create: `apps/api/src/modules/inbox/{risk.ts,risk.spec.ts,approval-id.ts,approval-id.spec.ts,executors.ts,inbox.service.ts,inbox.controller.ts,reconciliation.job.ts,inbox.module.ts}`, `apps/api/test/inbox/inbox.int.spec.ts`, `apps/api/test/inbox/decision.e2e.spec.ts`

**Interfaces:**
- Consumes: `TenantPrismaService.tx`, `StreamsService.publish`, `BillingService.record`, `WatchtowerService.review`, `ClientsService`.
- Produces:
  - `READ_ACTIONS = new Set(["get_positions", "get_transactions", "analyze_portfolio"])`, `REVERSIBLE_ACTIONS = new Set(["create_alert", "update_goal", "schedule_report"])`.
  - `classifyRisk(action: string): RiskClass`: devolve `read`, `reversible` ou, para qualquer outra ação, `irreversible`.
  - `approvalId(threadId: string, action: string, payload: unknown): string`: `sha256(`${threadId}|${action}|${stableStringify(payload)}`)` em hex. O `stableStringify` ordena as chaves recursivamente.
  - `ExecutorRegistry.register(action: string, fn: (payload) => Promise<unknown>)` e `ExecutorRegistry.get(action)`. No boot são registrados os executores simulados:
    - `place_trade`: devolve `{ orderId: "SIM-" + 8 hex, status: "filled" }`;
    - `transfer` e `rebalance`: devolvem `{ protocol: "SIM-…", status: "accepted" }`;
    - `create_alert`: devolve `{ alertId }`;
    - as ações `READ` leem `position`/`transaction`.
  - `InboxService.request(input: { threadId: string; agent: string; action: string; payload: Record<string, unknown>; valueBrl: string }): Promise<{ approvalId: string; created: boolean }>`: upsert idempotente com `expires_at = now + APPROVAL_TTL_HOURS`; quando a linha é criada, publica `approval.created`.
  - `InboxService.listPending(clientExternalId): Promise<ApprovalView[]>` e `InboxService.get(id)`.
  - `InboxService.decide(id: string, decision: DecisionRequest, by: AuthTenant): Promise<ApprovalView>`. Numa `tx`:
    1. `SELECT … FOR UPDATE`; inexistente → `NotFoundError`;
    2. se expirou, marca `expired` e lança `ApprovalConflictError`; se não está `pending`, lança `ApprovalConflictError`;
    3. grava `status`, `decided_by_key_id`, `decided_at` e `reason`.

    Depois do commit, publica `resume` em `jobs`.
  - `InboxService.executeOnce(approvalId: string): Promise<{ status: "succeeded" | "failed" | "skipped"; result?: unknown }>`. A sequência:
    1. `INSERT executed_action(status='started') ON CONFLICT DO NOTHING`; se nada foi inserido, devolve `skipped`.
    2. Chama o executor registrado.
    3. Grava `succeeded`/`failed` com o resultado.
    4. Em `succeeded`, cobra `execution` com `valueBrl` e grava um `audit_event` (`channel: "worker"`), ambos na mesma `tx`.
    5. Publica `approval.executed`.
  - `ReconciliationJob` (`@Cron("0 * * * * *")`), varrendo todos os tenants com o papel migrator só para listar os ids e operando cada um sob `TenantContext`:
    - `pending` com `expires_at < now()` → `expired` e `resume { approved: false }`;
    - `approved` sem `executed_action` há mais de 2 min → republica `resume`;
    - `executed_action.started` há mais de 5 min → `needs_review`.
  - Rotas:
    - `GET /api/clients/:clientId/inbox`: escopos `chat` ou `inbox:decide`;
    - `POST /api/inbox/:id/decision`: escopo `inbox:decide`; responde 200 com `ApprovalView`.

- [ ] **Step 1: Testes que falham**:
  - **Unidade:**
    - `classifyRisk("place_trade") === "irreversible"`, `classifyRisk("pix_out") === "irreversible"`, `classifyRisk("get_positions") === "read"`;
    - `approvalId` não muda quando a ordem das chaves do payload muda;
    - `approvalId` muda quando um valor muda.
  - **`inbox.int.spec.ts`:**
    - chamar `request` duas vezes com os mesmos dados dá uma linha e um único `approval.created`;
    - **duas `decide` aprovando em paralelo** → uma resolve e a outra lança `ApprovalConflictError` (Review Focus 3);
    - **dois `executeOnce` em paralelo** → o executor é chamado uma vez, e um dos dois devolve `skipped`;
    - um executor que lança erro leva a `failed` e não gera cobrança;
    - o `ReconciliationJob` com relógio adiantado expira as pendentes e marca `started` antigo como `needs_review`, sem chamar o executor.
  - **`decision.e2e.spec.ts`:**
    - chave sem `inbox:decide` → 403;
    - decisão em solicitação de outro tenant → 404;
    - decisão em solicitação expirada → 409 (Review Focus 3).
- [ ] **Step 2:** Rodar `pnpm --filter api test:unit -- inbox && pnpm --filter api test:int -- inbox && pnpm --filter api test:e2e -- decision`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar de novo. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(api): inbox com risco padrão irreversível, decisão travada e execução no máximo uma vez`

---

### Task 17: Agentes (navigator, insight, predictor, risk, executor)

**Files:**
- Create: `apps/api/src/modules/agents/{agent.ts,prompts.ts,navigator.ts,insight.ts,predictor.ts,risk.ts,executor.ts,mock-responders.ts,agents.module.ts}` com specs.

**Interfaces:**
- Consumes: `ModelFactory.chat` (Task 11), `KnowledgeService.search` (Task 12), schemas do shared (Task 2).
- Produces:
  - `buildSystemPrompt(p: { identity: string; context: string; task: string; rule: string }): string`: molde `# IDENTIDADE\n…\n\n# CONTEXTO\n…\n\n# TAREFA\n…\n\n# REGRA\n…`.
  - `interface AgentDef<O> { name: AgentName; role: Role; prompt: string; schema?: ZodType<O>; run(input: { question: string; history: BaseMessage[]; knowledge: SearchResult; results?: Record<string, unknown> }): Promise<O | string> }`.
  - `AgentRegistry.get(name: AgentName): AgentDef<unknown>`.
  - **Prompts:** portar de `legacy/python/carina/agents/` (identidade, contexto, tarefa e regra) para Navigator, Insight, Predictor e RebalancerRisk, trocando as menções a FalkorDB/grafo por "base de conhecimento do cliente". O Executor ganha prompt próprio:
    - identidade: "Você prepara ações financeiras propostas pelo cliente";
    - tarefa: "Converta o pedido em uma ação estruturada (`ActionProposal`)";
    - regra: "Nunca execute; apenas proponha. Use ações conhecidas: place_trade, transfer, rebalance, create_alert, get_positions".
  - O Navigator tem dois modos: `answer` (caminho simples) e `synthesize`, este com prompt extra que exige mencionar análises que falharam e incluir disclaimer quando houver projeção ou tributação.
  - **Saídas:** Predictor usa `CashFlowForecastSchema`, risk usa `RiskAssessmentSchema` e executor usa `ActionProposalSchema`. Insight e navigator devolvem texto.
  - **`mock-responders.ts`**, registrado no `MockChatModel`, todos determinísticos:
    - `classifier`: aplica a heurística da Task 18 à última mensagem do usuário;
    - `insight`: `"Composição da carteira: " + títulos dos 3 primeiros chunks + " (fonte: base de conhecimento)."`;
    - `predictor`: 3 cenários (`base`, `otimista` e `pessimista`, de 12 meses) com `projectedNetFlowBrl` `"120000.00"`, `"180000.00"` e `"60000.00"`, `confidence` 0.6/0.3/0.1 e narrativa contendo "estimativa" e "premissas";
    - `risk`: drift `4.5`, VaR `"85000.00"` e 1 sugestão;
    - `executor`: a regex `/(compr|vend)\w*\s+(\d+)\s+(?:ações\s+(?:de|da|do)\s+)?([A-Z]{4}\d{1,2})/i` gera `place_trade` com `{ side: "buy" | "sell", assetCode, quantity }` e `valueBrl = quantity × 30.00`; sem casamento, gera `create_alert`;
    - `navigator`/`synthesize`: concatena os resultados com o prefixo `"Resumo: "` e termina com `"Isto não constitui recomendação de investimento."`.

- [ ] **Step 1: Testes que falham**:
  - `buildSystemPrompt` produz as 4 seções na ordem;
  - em modo mock, `predictor.run` devolve um objeto que passa no `CashFlowForecastSchema`;
  - `executor.run({ question: "compre 100 ações de PETR4" })` devolve `{ action: "place_trade", payload: { side: "buy", assetCode: "PETR4", quantity: 100 }, valueBrl: "3000.00" }`;
  - `inspectText` da resposta do `synthesize` mock não gera nenhuma flag de violação.
- [ ] **Step 2:** Rodar `pnpm --filter api test:unit -- agents`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar de novo. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(api): 5 agentes com prompts portados, schemas Zod e respostas mock determinísticas`

---

### Task 18: Orquestrador LangGraph

**Files:**
- Create: `apps/api/src/modules/orchestrator/{state.ts,heuristic.ts,heuristic.spec.ts,graph.ts,graph.spec.ts,checkpointer.ts,orchestrator.service.ts,orchestrator.module.ts}`, `apps/api/test/orchestrator/orchestrator.int.spec.ts`

**Interfaces:**
- Consumes: `AgentRegistry` (Task 17), `KnowledgeService.search`, `InboxService.request`/`executeOnce` (Task 16), `classifyRisk`, `StreamsService.publish`, `ModelFactory.chat("reasoning", { schema: PlanSchema, mockKey: "classifier" })`.
- Produces:
  - `heuristicPlan(query: string): Plan`. Palavras-chave (substring, minúsculas), portadas do Python mais as de execução:
    - `insight`: `portfólio`, `carteira`, `gasto`, `anomalia`, `composição`, `concentr`;
    - `risk`: `risco`, `var`, `volatil`, `stress`, `correlação`, `rebalance`;
    - `predictor`: `projeção`, `fluxo de caixa`, `cenário`, `futuro`, `previsão`;
    - `wantsExecution` quando casa `/\b(compr|vend|transfir|transfer|resgat|aplicar|rebalanceie)/`.

    A complexidade é `simples` sem agentes, `média` com 1 e `complexa` com 2 ou mais. Com `wantsExecution` e sem agentes, fica `média`.
  - **`GraphState`** (`Annotation.Root`):
    - `messages` (reducer append; o corte em 20 é aplicado ao montar as chamadas);
    - `question: string`, `plan?: Plan`, `knowledge?: SearchResult`;
    - `results: Record<string, unknown>` (reducer merge), `errors: Record<string, string>` (reducer merge);
    - `answer?: string`;
    - `pending?: { approvalId: string }`, `execution?: { approvalId; status; result? }`.
  - **Grafo:**

```
START → classify → retrieve
retrieve → (plan.agents vazio) → answer → maybeExecute
retrieve → Send("specialist", {agent}) para cada agente → synthesize → maybeExecute
maybeExecute → (plan.wantsExecution) → executor → END
maybeExecute → END
```

  - **Nós:**
    - `classify`: chama o classificador; em qualquer erro, usa `heuristicPlan`.
    - `retrieve`: chama `KnowledgeService.search(question)`.
    - `specialist`: roda o agente; um erro vira `errors[agent]`, nunca derruba o grafo.
    - `answer`/`synthesize`: navigator.
    - `executor`:
      1. `proposal = executor.run(...)`, depois `risk = classifyRisk(proposal.action)`;
      2. `read`: chama `ExecutorRegistry.get(...)` direto e grava em `results.executor`;
      3. `reversible`: executa e publica `notification`;
      4. `irreversible`: `InboxService.request(...)` e depois `const decision = interrupt({ approvalId })`. **Nada antes do `interrupt()` pode ter efeito não idempotente.** Depois da retomada: se `decision.approved`, `execution = await InboxService.executeOnce(approvalId)`; senão, `execution = { approvalId, status: "rejected" }`.
  - `createCheckpointer(env): PostgresSaver`: `PostgresSaver.fromConnString(DATABASE_URL, { schema: "langgraph" })`. Se a versão instalada não aceitar `schema`, usar `?options=-c%20search_path%3Dlanggraph` na URL. `setup()` roda no boot.
  - `OrchestratorService.stream(input: { threadId: string; question: string }): AsyncIterable<ChatEvent>`. Converte `graph.stream(..., { configurable: { thread_id }, streamMode: ["updates", "messages", "custom"] })` em `ChatEvent`:
    - fim de `classify` → `plan`;
    - início de `specialist` → `agent_started`;
    - pedaços de mensagem → `token`;
    - resultado de cada nó → `agent_result`;
    - `__interrupt__` → `approval_required` (com `InboxService.get`).

    O `done` **não** é emitido aqui; quem emite é o ChatService (Task 20).
  - `OrchestratorService.resume(threadId: string, approved: boolean): Promise<{ execution }>`: `graph.invoke(new Command({ resume: { approved } }), { configurable: { thread_id } })`.
  - `OrchestratorService.finalState(threadId): Promise<GraphStateValue>`.

- [ ] **Step 1: Testes que falham**:
  - **`heuristic.spec.ts`:**
    - `"olá"` → `simples`, sem agentes;
    - `"qual o risco da minha carteira?"` → `complexa`, `insight` + `risk`;
    - `"compre 100 PETR4"` → `média`, `wantsExecution: true`.
  - **`graph.spec.ts`** (modo mock, `MemorySaver`, conhecimento falso):
    - pergunta simples → só `answer`, `results` vazio;
    - `"projeção e risco da carteira"` → `insight`, `risk` e `predictor` rodam (os `agent_started` dos três chegam antes do primeiro `agent_result`) e a síntese vem por último;
    - specialist `risk` falhando → `errors.risk` preenchido e síntese produzida mesmo assim;
    - classificador lançando erro → o plano vem da heurística;
    - um thread com 30 mensagens anteriores faz cada agente receber no máximo 20 mensagens de histórico, além do system prompt.
  - **`orchestrator.int.spec.ts`** (Postgres real, `PostgresSaver`):
    - `"compre 100 ações de PETR4"` → o stream termina com `approval_required`;
    - `approval_request` fica `pending`;
    - o executor simulado ainda não foi chamado;
    - `resume(threadId, true)` gera `execution.status === "succeeded"` e o executor é chamado uma vez;
    - **um novo `OrchestratorService`** (simulando restart) retoma o mesmo thread com sucesso;
    - `resume(threadId, true)` chamado de novo não chama o executor (`skipped`).
- [ ] **Step 2:** Rodar `pnpm --filter api test:unit -- orchestrator && pnpm --filter api test:int -- orchestrator`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar de novo. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(api): orquestrador LangGraph com especialistas em paralelo, síntese e interrupt durável`

---

### Task 19: Worker de retomada

**Files:**
- Create: `apps/api/src/modules/orchestrator/resume.worker.ts`, `apps/api/test/orchestrator/resume.int.spec.ts`

**Interfaces:**
- Consumes: `StreamsService.consume` (grupo `resumers` em `jobs`), `OrchestratorService.resume`, `TenantContext.run`.
- Produces: `ResumeWorker`, que trata `resume { tenantId, clientId, approvalId, threadId, approved }` dentro de `TenantContext.run({ tenantId, clientId })` e ignora os outros tipos de evento. Ele é iniciado em `onApplicationBootstrap` quando `WORKERS_ENABLED !== "false"`, e o mesmo vale para o `SyncWorker` e o `ReconciliationJob`.

- [ ] **Step 1: Teste que falha:**
  1. Uma conversa pausada é criada como na Task 18.
  2. `InboxService.decide(id, { approved: true }, approver)` é chamado, com `approver` sendo o `AuthTenant` de uma chave com `inbox:decide`.
  3. Em até 10 s (polling), a solicitação tem `executed_action.status = "succeeded"`.
  4. Existe um `usage_record` do tipo `execution` com `fee_brl = 15.00` (valor de R$ 3.000,00 × 0,5%).
  5. Há um evento `approval.executed` em `inbox.events`.

  Um segundo `resume` publicado para o mesmo approval não gera um segundo `usage_record`.
- [ ] **Step 2:** Rodar `pnpm --filter api test:int -- resume`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar de novo. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(api): worker de retomada via Redis Streams`

---

### Task 20: Chat — REST, ticket e WebSocket com streaming

**Files:**
- Create: `apps/api/src/modules/chat/{chat.service.ts,chat.controller.ts,ws-ticket.service.ts,chat.gateway.ts,inbox-broadcast.ts,chat.module.ts}`, `apps/api/test/chat/chat.e2e.spec.ts`, `apps/api/test/chat/ws.e2e.spec.ts`

**Interfaces:**
- Consumes: `QuotaService` (Task 8), `ClientsService` (Task 7), `OrchestratorService` (Task 18), `BillingService`, `WatchtowerService`, `TenantPrismaService.tx`, `StreamsService.tail`.
- Produces:
  - `ChatService.run(tenant: AuthTenant, req: ChatRequest, channel: "rest" | "ws"): AsyncIterable<ChatEvent>`. A sequência:
    1. Valida a requisição; erro vira `ValidationError` **antes** de reservar a cota.
    2. `reserve`.
    3. `resolve(clientId, { create: true })`.
    4. Monta o `threadId`: o recebido precisa ter o prefixo `${tenantId}:${clientUuid}:`, senão `NotFoundError`; sem `threadId`, gera um novo.
    5. Repassa os eventos do orquestrador, rodando-o dentro de `TenantContext.withClient(clientUuid, …)`, porque a busca no conhecimento exige o cliente fixado.
    6. No fim, numa `tx`: `BillingService.record` (`classifyWork(plan.agents)`) e `WatchtowerService.review` (texto = `answer` + resultados serializados).
    7. Emite `done` com `status` `awaiting_approval` se houve `approval_required`, senão `completed`.

    Se qualquer erro acontecer antes do `done`: `refund`, emite `error { code, traceId }` e não cobra nada.
  - `POST /api/chat` (escopo `chat`): consome o iterável e devolve `{ threadId, status, plan, results, answer, approval?, usage, compliance }`. Mapeia `AllProvidersFailedError` → 503.
  - `WsTicketService.issue(tenant: AuthTenant): Promise<{ ticket: string; expiresInSeconds: 30 }>` grava em Redis `ws:ticket:<ticket>` com TTL de 30 s; `consume(ticket): Promise<AuthTenant | null>` usa `GETDEL`.
  - `POST /api/ws/ticket` (escopo `chat`).
  - `ChatGateway` (`@nestjs/platform-ws`, caminho `/ws/chat`):
    - sem ticket válido, fecha com código 4401;
    - cada mensagem JSON `ChatRequest` vira um `ChatService.run(..., "ws")`, e cada `ChatEvent` é enviado como JSON;
    - na mesma conexão, recebe também `approval_required` e `approval_executed` de `inbox.events` do próprio tenant (via `InboxBroadcast`).
  - `InboxBroadcast`: um único `StreamsService.tail("inbox.events")` por processo, que distribui para os sockets do tenant do evento. Para `approval.created` e `approval.executed`, busca a `ApprovalView` sob o contexto do tenant e emite o `ChatEvent` correspondente.

- [ ] **Step 1: Testes que falham**:
  - **`chat.e2e.spec.ts`:**
    - `"olá"` → 200, `status: "completed"`, `usage.workType: "query"`, `usage.priceBrl: "1.50"`, um `audit_event` gravado;
    - `"qual o risco e a projeção da minha carteira?"` → `multi_agent_analysis`;
    - `"compre 100 ações de PETR4"` → `status: "awaiting_approval"` com `approval.valueBrl: "3000.00"`;
    - `message` com 8.001 caracteres ou só espaços → 422, sem `usage_record` e com o contador de cota inalterado (Review Focus 2);
    - classificador e modelos lançando erro (override de todos os mock responders) → 503 com `Retry-After`, cota devolvida e nenhum `usage_record` (Review Focus 4);
    - `threadId` de outro cliente → 404.
  - **`ws.e2e.spec.ts`** (cliente `ws`):
    - conectar sem ticket fecha com 4401;
    - um ticket reutilizado fecha com 4401;
    - `"projeção da carteira"` produz eventos na ordem `plan` → `agent_started` → … → `agent_result` → `done`;
    - um socket aberto do tenant A recebe `approval_executed` quando a aprovação de A é executada, e o socket de B não recebe nada;
    - erro do provedor no meio do stream gera um evento `error` com `traceId` e sem texto interno (Review Focus 4).
- [ ] **Step 2:** Rodar `pnpm --filter api test:e2e -- chat ws`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar de novo. Esperado: PASS.
- [ ] **Step 5: Commit** `feat(api): chat REST e WebSocket com ticket, streaming, cobrança e auditoria atômicas`

---

### Task 21: Boot, health, seed e Docker Compose

**Files:**
- Create:
  - `apps/api/src/{main.ts,main.worker.ts,app.module.ts,worker.module.ts}`, `apps/api/src/modules/health/health.controller.ts`, `apps/api/src/seed/seed.ts`;
  - `apps/api/Dockerfile`, `apps/web/Dockerfile` (stub de build estático, completado na Task 22);
  - `apps/api/test/health/health.e2e.spec.ts`, `apps/api/test/seed/seed.int.spec.ts`.
- Modify: `docker-compose.yml` (adiciona `migrate`, `seed`, `api` e `web`), `.env.example`

**Interfaces:**
- Produces:
  - `main.ts`: Nest com o adapter `WsAdapter`, prefixo `/api`, CORS restrito a `WEB_ORIGIN`, `ProblemDetailsFilter` global, pino e `enableShutdownHooks`.
  - `main.worker.ts`: mesmo módulo com `WORKERS_ENABLED=true` e sem HTTP.
  - Rotas públicas `GET /api/health` → `{ status: "ok" }` e `GET /api/ready` → `{ postgres: "ok", redis: "ok" }`, ou 503 com o serviço que falhou.
  - `seed.ts` (`pnpm --filter api seed`), idempotente, usando o papel migrator para criar tenant e chaves:
    - tenant `demo` (`rpm` 120, cota 0);
    - chave `DEMO_APP_KEY` com escopos `chat` e `data:write`;
    - chave `DEMO_APPROVER_KEY` com escopos `chat` e `inbox:decide`. Os valores vêm do env, com defaults fixos `sk-live-demoapp000000000000000000000000` e `sk-live-demoapprover0000000000000000000`, documentados como só para demo;
    - os clientes `cliente-conservador`, `cliente-moderado` e `cliente-arrojado` recebem o portfólio sintético (seeds 1, 2 e 3, `asOf` = hoje) via `IngestionService` (`source: "synthetic"`), e depois `SyncWorker.syncClient` roda direto.
  - **docker-compose:**
    - `postgres` (com `init.sql`) e `redis`, ambos com healthcheck;
    - `migrate` (`prisma migrate deploy`), roda uma vez;
    - `seed`, roda uma vez depois de `migrate`;
    - `api` (porta 3000, `LLM_MODE=${LLM_MODE:-mock}`), depois de `seed`;
    - `web` (porta 5173), depois de `api`.

- [ ] **Step 1: Testes que falham**:
  - `health.e2e.spec.ts`: `/api/health` responde 200 sem chave; `/api/ready` responde 200 com os dois serviços `ok`.
  - `seed.int.spec.ts`:
    - rodar `seed()` duas vezes deixa 1 tenant, 2 chaves e 3 clientes;
    - cada cliente tem posições e ≥ 2 documentos de conhecimento;
    - a chave app autentica e não tem `inbox:decide`.
- [ ] **Step 2:** Rodar `pnpm --filter api test:e2e -- health && pnpm --filter api test:int -- seed`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar de novo. Esperado: PASS. Onde houver Docker, rodar também `docker compose up --build -d && curl -s localhost:3000/api/ready` e conferir `{"postgres":"ok","redis":"ok"}`.
- [ ] **Step 5: Commit** `feat: boot da API e do worker, health/ready, seed de demo e docker compose`

---

### Task 22: Frontend React

**Files:**
- Create: `apps/web/{vite.config.ts,index.html}`, `apps/web/src/{main.tsx,App.tsx,api/client.ts,api/ws.ts,state/session.ts}`, `apps/web/src/features/{connect/ConnectScreen.tsx,chat/ChatView.tsx,chat/AgentCard.tsx,inbox/InboxPanel.tsx,usage/UsagePanel.tsx,portfolio/PortfolioPanel.tsx}` e um `*.test.tsx` para cada feature.
- Modify: `apps/web/Dockerfile` (build do Vite servido por `nginx:alpine` com proxy de `/api` e `/ws` para `api:3000`)

**Interfaces:**
- Consumes: as rotas das Tasks 7, 9, 10, 13, 16 e 20 e os schemas de `@carina/shared`.
- Produces:
  - `session.ts`: `getApiKey()`/`setApiKey()` com `sessionStorage` envolto em try/catch.
  - `client.ts`: `apiFetch<T>(path, schema: ZodType<T>, init?)`. Valida a resposta com o schema e, se a resposta for um `Problem`, lança `ApiProblemError`.
  - `ws.ts`: `connectChat(onEvent: (e: ChatEvent) => void): Promise<{ send(req: ChatRequest): void; close(): void }>`. Pede o ticket, conecta e valida cada mensagem com `ChatEventSchema`. Reconecta com backoff de 1 s, 2 s e 4 s, pedindo um ticket novo a cada tentativa.
  - **Telas:**
    - `ConnectScreen`: campo da chave, validada com `GET /api/clients`; o texto de ajuda cita as chaves de demo do README.
    - `App`: layout em duas colunas e uma coluna abaixo de 768 px, com seletor de cliente.
    - `ChatView`: mensagens e um `AgentCard` por agente, mostrando "pensando" no `agent_started`, texto em streaming por `token` e resultado estruturado formatado (cenários do Predictor em tabela, VaR em R$).
    - `InboxPanel`: lista de pendentes, atualizada por `approval_required` e `approval_executed`, com botões Aprovar/Rejeitar. Desabilitados quando a chave não tem `inbox:decide`: o erro 403 mostra a mensagem "Esta chave não pode aprovar".
    - `UsagePanel`: totais do mês e últimos eventos de auditoria, com as flags em destaque.
    - `PortfolioPanel`: posições agrupadas por classe.
  - CSS Modules com tokens de cor em `:root`, tema escuro via `prefers-color-scheme`, foco visível e rótulos em todos os campos.

- [ ] **Step 1: Testes que falham** (Vitest + Testing Library + `msw` para HTTP e um WebSocket falso):
  - `ConnectScreen`: uma chave inválida (401) mostra "Chave inválida"; uma válida leva ao App;
  - `ChatView`: a sequência de eventos `plan → agent_started(insight) → token×3 → agent_result → done` renderiza o card do Insight com o texto completo e o rodapé de custo "R$ 7,50";
  - `InboxPanel`: aprovar chama `POST /api/inbox/:id/decision` com `{ approved: true }`, e o item sai da lista ao receber `approval_executed`;
  - `apiFetch`: uma resposta fora do schema lança erro, em vez de renderizar dado inválido.
- [ ] **Step 2:** Rodar `pnpm --filter web test`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar `pnpm --filter web test && pnpm --filter web build`. Esperado: PASS e build sem erros.
- [ ] **Step 5: Commit** `feat(web): interface React com chat em streaming, inbox em tempo real, uso e carteira`

---

### Task 23: Fluxo completo, README e CI final

**Files:**
- Create: `apps/api/test/flow/full-flow.e2e.spec.ts`
- Modify: `README.md` (reescrito), `docs/ARCHITECTURE.md` (reescrito para a versão TS), `.github/workflows/ci.yml` (inclui `test:int` e `test:e2e`)

**Interfaces:**
- Consumes: tudo.

- [ ] **Step 1: Teste E2E do fluxo completo** (app real + seed, `LLM_MODE=mock`):
  1. Com a chave app: `POST /api/chat` com `"compre 100 ações de PETR4"` para `cliente-moderado` → `awaiting_approval`.
  2. Com a chave app: `POST /api/inbox/:id/decision` → 403.
  3. Com a chave aprovadora: a mesma decisão → 200.
  4. Em até 10 s, `GET /api/usage` mostra exatamente 1 `query` (R$ 1,50: o pedido de compra não aciona especialistas) e 1 `execution` com R$ 90,00 (75,00 + 15,00). O seed grava pelo serviço, não pela rota, então não gera `data_ingestion`.
  5. `GET /api/audit` mostra o evento do chat e o da execução.
  6. `GET /api/clients/cliente-moderado/inbox` volta vazio.
- [ ] **Step 2:** Rodar `pnpm --filter api test:e2e -- full-flow`. Esperado: PASS. Se falhar, a correção vai na task que é dona do comportamento, não no teste.
- [ ] **Step 3:** Reescrever o `README.md`:
  - o que é o CARINA e por que ele foi migrado;
  - `docker compose up` e as chaves de demo;
  - diagrama da arquitetura (do spec §3);
  - decisões de arquitetura (tabela do spec §2);
  - "Defeitos do Python corrigidos" (spec §11);
  - garantias provadas por testes (RLS, execução única, append-only), com os nomes dos arquivos de teste;
  - como rodar os testes;
  - roadmap das fases 2 e 3.

  O `docs/ARCHITECTURE.md` passa a descrever a versão TypeScript.
- [ ] **Step 4:** Atualizar o `ci.yml` para rodar `pnpm --filter api test:int` e `pnpm --filter api test:e2e` com os service containers. Conferir a cobertura de linhas ≥ 80% em `apps/api/src/modules/**` (`vitest --coverage`, com threshold configurado).
- [ ] **Step 5:** Rodar localmente, de ponta a ponta, `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter api test:int && pnpm --filter api test:e2e && pnpm build`. Esperado: tudo verde.
- [ ] **Step 6: Commit** `test: fluxo completo E2E; docs: README e arquitetura da versão TypeScript; ci: integração e E2E`
