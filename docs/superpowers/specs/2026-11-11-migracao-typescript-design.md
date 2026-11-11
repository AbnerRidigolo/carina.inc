# Migração do CARINA para TypeScript / Node.js — Design

- **Data:** 2026-11-11
- **Status:** aprovado em conversa (seções 1–4); aguardando revisão deste documento
- **Escopo:** reescrever o CARINA Wealth AI v3 (Python, ~9,5 mil linhas, 138 testes) como monorepo
  TypeScript, corrigindo na migração os defeitos encontrados na análise do código atual.

---

## 1. Objetivo e critérios de sucesso

**Por quê:** o projeto será apresentado na empresa onde o autor trabalha, cujo stack é
TypeScript/JavaScript/Node.js, como portfólio para uma vaga de dev PJ. Quem avalia são devs e tech
leads, que vão ler o código e rodar a demo.

**Sucesso significa:**

1. Um avaliador clona o repositório, roda `docker compose up` **sem nenhuma chave de API** e usa o
   fluxo completo pela interface web: pergunta → agentes em paralelo → resposta em streaming →
   ação irreversível pausada → aprovação → execução única, cobrada e auditada.
2. O código mostra domínio de TypeScript estrito, NestJS, Prisma/PostgreSQL, Redis e React, com
   fronteiras de módulo claras.
3. CI verde com lint, checagem de tipos, testes de unidade, integração (Postgres e Redis reais) e
   E2E, além do build.
4. As garantias críticas são **provadas por testes**: isolamento entre clientes (RLS), execução
   única de ações irreversíveis e trilha de auditoria append-only.
5. O README explica as decisões de arquitetura e os defeitos do Python que a migração corrigiu.

**Fora de escopo:** deploy em produção com clientes reais, integração real com corretoras (o
executor de ordens é simulado), paridade de prompts palavra por palavra e suporte a Python no
repositório depois que a migração terminar.

---

## 2. Decisões

| Tema | Decisão | Alternativas descartadas (motivo) |
|---|---|---|
| Organização | Monorepo **pnpm workspaces** | Nx (configuração demais para o tamanho), repositórios separados (tipos duplicados) |
| Backend | **NestJS 12** (ESM, Node ≥ 22.12) | Express/Fastify puros (organização toda manual) |
| Frontend | **React + Vite** | Next.js (peças demais ao lado do NestJS), Angular |
| Dados transacionais | **PostgreSQL 17 + Prisma** | Tudo no FalkorDB (pouco reconhecido; não serve para dado transacional) |
| Conhecimento | **pgvector no mesmo Postgres**, grafo modelado em tabelas, isolamento por **RLS** | Neo4j (Community tem 1 banco e nenhum controle de acesso por papel; o Aura Free pausa após 3 dias), FalkorDB (licença SSPL, ecossistema JS fraco) |
| Agentes | **LangGraph.js** (orquestração, `interrupt()`, checkpointer Postgres) | Vercel AI SDK (sem pausa durável pronta, major nova a cada ~6 meses), Mastra (licença `ee/`, adaptador NestJS pré-1.0) |
| Modelos | **LangChain.js**: OpenRouter → reservas → Groq via `withFallbacks()`; embeddings NVIDIA (OpenAI-compatible) | LiteLLM (só Python), misturar LangChain com AI SDK (dois sistemas de mensagens) |
| Cache, limites, eventos | **Redis**: chaves com TTL (cache), sorted set e `INCR` (limites), **Redis Streams** com consumer groups (eventos e jobs) | Limites em memória (não valem com várias instâncias), Modal (só Python) |
| Agendamento | `@nestjs/schedule` publicando em Streams | BullMQ (fica como evolução se precisar) |
| Testes | **Vitest**, Supertest, Testcontainers, Testing Library | Jest (problemas com pacotes só-ESM do NestJS 12) |
| Qualidade | TypeScript `strict`, ESLint + Prettier, versões fixadas no lockfile | — |

Fatos de bibliotecas (versões, recursos por edição, licenças) foram verificados na web em
2026-11-07; as fontes estão nos relatórios da pesquisa registrados na conversa de design.

---

## 3. Arquitetura

```
                ┌──────────────────────┐
  Navegador ──▶ │ apps/web (React+Vite)│
                └─────────┬────────────┘
                REST + WebSocket (chave de API / ticket)
                ┌─────────▼─────────────────────────────────────┐
                │ apps/api (NestJS 12)                           │
                │  Guards: ApiKeyGuard → RateLimitGuard           │
                │  TenantContext (AsyncLocalStorage) → RLS        │
                │  Orquestrador: grafo LangGraph.js               │
                │    classificar → especialistas (Send, paralelo) │
                │    → síntese · interrupt() para aprovação       │
                │  Workers: consumidores de Redis Streams         │
                └──────┬──────────────────────────┬──────────────┘
                       ▼                          ▼
        PostgreSQL 17 + pgvector (Prisma)       Redis 7
        · transacional (RLS)                    · cache com TTL
        · conhecimento kg_* (RLS)               · limites e cota atômicos
        · schema langgraph (checkpoints)        · Streams + DLQ
                       │
        LangChain.js → OpenRouter → reservas → Groq · embeddings NVIDIA
        LLM_MODE=mock → modelos falsos determinísticos (demo e testes)
```

### 3.1 Estrutura do repositório

```
apps/
  api/                 NestJS
    src/core/          config · database · redis · logging · errors
    src/modules/       tenancy · limits · llm · knowledge · agents · orchestrator ·
                       inbox · billing · watchtower · chat · (fase 2/3: aops · market ·
                       evaluation · builder · open-finance · notifications · monitor)
    src/main.ts        HTTP + WebSocket + workers
    src/main.worker.ts só workers (opcional, mesmo código)
    prisma/            schema.prisma · migrations/ (incluindo SQL de RLS e pgvector)
    config/models.yaml roteamento de modelos por papel
    test/              integração e E2E
  web/                 React + Vite
packages/
  shared/              schemas Zod e tipos: contratos REST, eventos de WebSocket e de Streams
legacy/python/         código Python atual, intocado até a fase 3; removido no fim
docker-compose.yml     postgres (pgvector/pgvector:pg17) · redis · api · web
```

### 3.2 Regras de fronteira

- **Só o módulo `llm` importa provedores de modelo**, e só `agents`/`orchestrator` importam LangGraph.
- **Só `core/database` cria o Prisma Client.** Todo acesso a dados acontece dentro da transação que
  fixa o tenant para a RLS.
- Módulos se comunicam por serviços injetados (com interfaces) ou por eventos de stream, **nunca**
  lendo tabelas de outro módulo.
- `packages/shared` não depende de nada do Node: o `web` o importa direto.

---

## 4. Módulos

| Módulo | Responsabilidade | Depende de | Origem no Python | Fase |
|---|---|---|---|---|
| core/config | `.env` e `models.yaml` validados com Zod; a app não sobe com configuração inválida | — | `config/` | 1 |
| core/database | `PrismaService`; extensão que fixa `app.tenant_id`/`app.client_id` por transação | config | — | 1 |
| core/redis | `CacheService` (TTL), `StreamsService` (publicar, consumer groups, ack, reclaim, DLQ) | config | `utils/cache` | 1 |
| tenancy | Hash das chaves, `ApiKeyGuard`, escopos, `@CurrentTenant()`, resolução de `client` | database | `b2b/tenants`, `api/auth` | 1 |
| limits | `RateLimitGuard` (janela deslizante) e cota mensal com reserva e devolução | redis, tenancy | `b2b/ratelimit` | 1 |
| llm | `ModelFactory` por papel, `withFallbacks()`, limitador por provedor, embeddings, modo mock | config, redis | `models/` | 1 |
| knowledge | Ingestão (chunks, entidades, relações, embeddings) e busca híbrida com citação; só SQL fixo e parametrizado | database, llm | `knowledge/` | 1 |
| agents | 12 agentes (prompt, schema Zod, ferramentas) e registro por nome | llm, knowledge | `agents/tier1-3` | 1: navigator, insight, predictor, risk, executor · 2: strategist, researcher, assessor_liaison, monitor, sync, categorizer, tax |
| orchestrator | Grafo LangGraph, checkpointer Postgres, corte do histórico | agents, inbox | `agents/orchestrator` | 1 |
| inbox | Classificação de risco, solicitações, decisão com trava, executores registrados, execução única, reconciliação | database, redis | `inbox/` | 1 |
| billing | Preço por tipo de trabalho, fee sobre valor executado, resumo de uso | database | `b2b/metering` | 1 |
| watchtower | Flags de compliance e trilha append-only | database | `b2b/watchtower` | 1 |
| chat | `POST /chat`, ticket de WebSocket, gateway com streaming | orchestrator, billing, watchtower, limits | `api/routes`, `api/ws` | 1 |
| aops | Procedimentos em linguagem natural, compilação, agenda, execução | agents, billing, watchtower, redis | `b2b/aops`, `modal_jobs/aops_job` | 2 |
| market | Cotações B3 (brapi) e macro BCB normalizados, cache | redis, billing | `data_engine/market_data` | 2 |
| evaluation | Benchmark SEAL BR (42 casos, gabarito nunca exposto) | watchtower, billing | `data_engine/evaluation`, `eval_dataset` | 2 |
| builder | Estratégias declarativas (`buy_hold`, `sma_cross`) e backtest sem lookahead | market, billing | `builder/` | 2 |
| open-finance | Adaptador Pluggy, conexões, Sync para o conhecimento | database, knowledge | `integrations/open_finance`, `modal_jobs/sync_job` | 3 |
| notifications | WhatsApp (Meta Cloud API) e SMTP, consumindo `notifications` | redis | `integrations/notify` | 3 |
| monitor | Vigilância periódica de carteiras e alertas | market, notifications | `modal_jobs/monitor_job` | 3 |

Deixam de existir: o keepalive do FalkorDB (o banco não pausa mais) e a UI Gradio (substituída por `apps/web`).

### 4.1 Camada de modelos

- `config/models.yaml` mantém o formato atual por papel (`conversational`, `reasoning`, `embeddings`),
  com `primary` e lista `fallback`.
- `ModelFactory.forRole(role, { schema?, tools? })` aplica `withStructuredOutput(schema)` ou
  `bindTools(tools)` **em cada modelo da cadeia antes** de encadear com `withFallbacks()`, e usa
  `maxRetries: 0` no primário para que um 429 passe logo para o próximo modelo.
- Antes de cada chamada, um token bucket no Redis por provedor (padrão 20 req/min para modelos `:free`).
- `LLM_MODE=mock`: modelos falsos determinísticos. Respostas indexadas por papel e agente; saídas
  estruturadas válidas para os schemas; embeddings determinísticos (hash do texto → vetor de 1024
  dimensões normalizado).

### 4.2 Agentes

Cada agente é um arquivo com: `name`, `role`, system prompt no molde
`# IDENTIDADE → # CONTEXTO → # TAREFA → # REGRA`, schema Zod opcional da saída, ferramentas
opcionais (por exemplo, `searchKnowledge`) e uma função `run(state)`. Os prompts atuais do Python são
portados como ponto de partida.

### 4.3 Orquestrador (grafo)

```
START → classify ──(simples)──────────────────────────▶ navigator → END
             └──(média/complexa)─ Send(especialista)×N ─▶ synthesize → END
                                    └─ executor ─ interrupt() ─▶ (retomada) ─▶ synthesize
```

- `classify` usa o papel `reasoning` com saída estruturada (`Plan`: complexidade, agentes, motivo) e
  cai na heurística por palavras-chave do Python se todos os modelos falharem.
- Especialistas rodam em paralelo via `Send`; a falha de um vira `{agent, error}` no estado, e a
  síntese menciona a análise que faltou.
- `synthesize` (Navigator) produz a resposta final a partir dos resultados. Isso corrige o Python,
  que prometia a síntese mas não a fazia.
- Estado por thread no `PostgresSaver` (schema `langgraph`); o histórico é cortado nas últimas
  20 mensagens antes de cada chamada de modelo.

---

## 5. Modelo de dados

### 5.1 Tabelas transacionais

| Tabela | Campos principais | Notas |
|---|---|---|
| `tenant` | id (uuid), name, plan, rpm, monthly_quota | quota 0 = ilimitada |
| `api_key` | id, tenant_id, hash (único), prefix, scopes (text[]), label, revoked_at | escopos: `chat`, `inbox:decide`, `admin` |
| `client` | id (uuid), tenant_id, external_id, `UNIQUE(tenant_id, external_id)` | substitui o id em string `{tenant}__{client}` |
| `approval_request` | id (determinístico), tenant_id, client_id, thread_id, agent, action, risk, payload (jsonb), value_brl, status, expires_at, decided_by_key_id, decided_at, reason | status: `pending`, `approved`, `rejected`, `expired` |
| `executed_action` | approval_request_id (PK), tenant_id, client_id, status (`started`, `succeeded`, `failed`, `needs_review`), result (jsonb), started_at, finished_at | garantia de execução no máximo uma vez |
| `usage_record` | id, tenant_id, client_id?, work_type, agents (text[]), price_brl, fee_brl, value_brl, duration_ms, created_at | append-only |
| `audit_event` | id, tenant_id, client_id?, channel, query, flags (jsonb), created_at | append-only |
| `aop`, `strategy` | — | fase 2 |
| `of_connection` | — | fase 3 |

Valores monetários em `numeric(18,2)` (Prisma `Decimal`), nunca float. A tabela de preços por tipo
de trabalho e o fee sobre valor são portados de `carina/b2b/metering.py`.

### 5.2 Conhecimento

```
kg_document (id, tenant_id, client_id, source, title, created_at)
kg_chunk    (id, tenant_id, client_id, document_id, content,
             embedding vector(1024), tsv tsvector GENERATED)
kg_entity   (id, tenant_id, client_id, type, name, properties jsonb, embedding vector(1024),
             UNIQUE(tenant_id, client_id, type, name))
kg_relation (id, tenant_id, client_id, source_id, target_id, type, properties jsonb, chunk_id)
             FK (tenant_id, client_id, source_id) → kg_entity(tenant_id, client_id, id)
             FK (tenant_id, client_id, target_id) → kg_entity(tenant_id, client_id, id)
```

- Índices: HNSW (`vector_cosine_ops`) nos embeddings, GIN no `tsv` (dicionário `portuguese`) e btree
  em `(tenant_id, client_id)`.
- **Busca híbrida:** top-k vetorial + top-k full-text nos chunks, combinados por reciprocal rank
  fusion → entidades citadas nesses chunks → vizinhança de 1 a 2 saltos via `WITH RECURSIVE`. Cada
  trecho devolvido carrega `document_id`/`chunk_id` para citação.
- Na transação de busca: `SET LOCAL hnsw.iterative_scan = relaxed_order`, para o filtro da RLS não
  derrubar o recall.
- Colunas `vector` são `Unsupported` no Prisma; as consultas ficam em SQL parametrizado num único
  `KnowledgeRepository`. **O LLM nunca gera SQL.**

### 5.3 Row-Level Security

- **Papéis:** `carina_migrator` (dono, roda migrações) e `carina_app` (API e workers;
  `NOSUPERUSER NOBYPASSRLS`).
- Todas as tabelas de dados de tenant usam `ENABLE` + `FORCE ROW LEVEL SECURITY`.
- **Políticas:**
  - Tabelas por tenant (`usage_record`, `audit_event`, `aop`, `strategy`):
    `tenant_id = current_setting('app.tenant_id', true)::uuid`.
  - Tabelas por cliente (`client`, `approval_request`, `executed_action`): tenant igual; se
    `app.client_id` estiver fixado, o cliente também precisa ser igual.
  - Conhecimento (`kg_*`): **tenant E cliente obrigatórios**; sem `app.client_id`, nenhuma linha.
  - Sem `app.tenant_id` fixado, `current_setting` retorna NULL e **nada volta** (falha fechada).
- **Autenticação:** função `resolve_api_key(hash)` com `SECURITY DEFINER`, que lê só `api_key` e
  devolve tenant, escopos e id da chave.
- **Append-only:** `REVOKE UPDATE, DELETE ON usage_record, audit_event FROM carina_app`.
- **Aplicação:** um guard preenche o `TenantContext` (AsyncLocalStorage); uma extensão do Prisma
  (`$extends`) executa cada operação dentro de `$transaction` com
  `set_config('app.tenant_id', …, true)` e `set_config('app.client_id', …, true)`. Workers fazem o
  mesmo a partir do payload do evento.
- **Checkpoints do LangGraph:** schema `langgraph`, sem RLS (tabelas da biblioteca). O `thread_id` é
  `tenantId:clientId:uuid`; a API nunca expõe threads, e um thread só é retomado a partir de uma
  `approval_request` (que está sob RLS) ou do chat do mesmo cliente.

---

## 6. Fluxos

### 6.1 Chat com streaming

1. O frontend chama `POST /ws/ticket` (autenticado pela chave) e recebe um ticket de uso único que
   vale 30 s no Redis; conecta em `/ws/chat?ticket=…`. A chave nunca vai na URL.
2. Mensagem `{clientId, message, threadId?}`, nesta ordem:
   1. limite por minuto;
   2. reserva atômica de 1 unidade da cota (devolvida em caso de falha);
   3. resolução do `client` (criado na primeira vez);
   4. `TenantContext`.
3. `graph.stream(input, { configurable: { thread_id }, streamMode: ["updates", "messages", "custom"] })`
   é traduzido em eventos tipados de `packages/shared`: `plan`, `agent_started`, `token`,
   `agent_result`, `approval_required`, `error` e `done`.
4. No fim, `usage_record` e `audit_event` (revisão do Watchtower) são gravados na mesma transação; o
   `done` leva `usage` e `compliance`.
5. `POST /chat` faz o mesmo sem streaming e devolve o resultado consolidado.

### 6.2 Aprovação de ação irreversível

1. **Nó executor:**
   - `classifyRisk(action)` usa listas explícitas de ações `READ` e `REVERSIBLE`; **qualquer outra
     ação é `IRREVERSIBLE`** (corrige o Python, que liberava ações desconhecidas).
   - `READ` executa direto; `REVERSIBLE` executa e publica em `notifications`.
   - `IRREVERSIBLE`: faz upsert da `approval_request` com id = hash(thread_id, ação, payload), o que
     é idempotente porque o nó roda de novo ao retomar; publica `approval.created` em `inbox.events`
     e chama `interrupt({ approvalId })`.
2. **Decisão:** `POST /inbox/:id/decision` exige o escopo `inbox:decide`. Em uma transação:
   1. `SELECT … FOR UPDATE`;
   2. confere `pending` e não expirada (senão 409);
   3. grava status, `decided_by_key_id`, `decided_at` e `reason`;
   4. após o commit, publica `resume` em `jobs`.
3. **Retomada (worker `resumers`):**
   1. fixa o `TenantContext`;
   2. roda `graph.invoke(new Command({ resume: { approved } }), { configurable: { thread_id } })`;
   3. depois do `interrupt()`, se aprovada: `INSERT executed_action(status='started')`. Se houver
      conflito, outro worker já executou e este para. Se não, chama o executor registrado e grava
      `succeeded` ou `failed` com o resultado.
4. **Garantia:** efeitos externos não cabem numa transação do banco, então a garantia é **no máximo
   uma vez**. Uma linha presa em `started` por mais de 5 min vira `needs_review` e **nunca é
   reexecutada automaticamente**.
5. **Reconciliação (a cada minuto):** marca como expiradas as solicitações vencidas (o grafo é
   retomado como rejeitado) e republica `resume` para aprovações confirmadas sem `executed_action`
   depois de 2 min. O banco é a fonte da verdade; o stream é só o gatilho.
6. **Sucesso:** `usage_record` do tipo `EXECUTION` (preço base + fee sobre `value_brl`),
   `audit_event` e evento `approval.executed`, que chega à interface pelo WebSocket.

### 6.3 Redis Streams

- Streams: `inbox.events`, `notifications` e `jobs`, cada um com consumer group.
- Consumo: `XREADGROUP BLOCK 5000`, com `XACK` só depois do sucesso.
- Retentativa: `XAUTOCLAIM` de mensagens paradas há mais de 60 s; depois de 5 entregas, a mensagem
  vai para `<stream>.dlq` com o erro.
- Idempotência: `SET dedup:<stream>:<eventId> NX EX 86400` antes de processar.
- Eventos tipados em `packages/shared` com schema Zod, validados ao consumir.

---

## 7. Tratamento de erros e observabilidade

- Erros de domínio com classes próprias (`QuotaExceededError`, `ApprovalConflictError`,
  `AllProvidersFailedError`, …) e um filtro global que responde em **RFC 9457**
  (`application/problem+json`) com `traceId`. Mensagens internas nunca vão para o cliente; no
  WebSocket, `{ type: "error", code, traceId }`.
- Mapeamento HTTP:

  | Situação | Status |
  |---|---|
  | Validação | 422 |
  | Sem chave ou chave inválida | 401 |
  | Sem escopo | 403 |
  | Recurso de outro tenant | 404 (não revela a existência) |
  | Conflito de decisão | 409 |
  | Limite por minuto ou cota | 429 com `Retry-After` |
  | Todos os provedores falharam | 503 com `Retry-After` |

- Logs com `nestjs-pino` em JSON, com `traceId`, `tenantId` e `clientId`; chaves de API, tokens e
  campos pessoais (CPF, e-mail, telefone) mascarados.
- `/health` (liveness) e `/ready` (Postgres e Redis respondendo).

---

## 8. Frontend (apps/web)

- **Telas:** conectar com chave de API (guardada em `sessionStorage`), chat por cliente com streaming
  e cartões por agente, inbox de aprovações em tempo real, e painel de uso e auditoria.
- Tipos e validação vêm de `packages/shared`; dados servidos via TanStack Query; WebSocket com
  reconexão.
- Sem biblioteca de design pesada: CSS modules ou Tailwind, com acessibilidade básica (foco,
  contraste, rótulos).

---

## 9. Testes

| Nível | Ferramentas | Cobre |
|---|---|---|
| Unidade | Vitest | Classificação de risco, preços e fee, regras do Watchtower, classificador heurístico, cadeia de reserva com modelos falsos, matemática do backtest. Os casos dos 138 testes Python servem de especificação |
| Integração | Vitest + Testcontainers (`pgvector/pgvector:pg17`, `redis:7`) | Isolamento por RLS entre tenants e entre clientes (incluindo busca vetorial), append-only, duas aprovações simultâneas executando uma única vez, reconciliação, retentativa e DLQ |
| E2E da API | Supertest + `LLM_MODE=mock` | Chat → aprovação → execução → uso e auditoria; 401/403/404/409/429 |
| Web | Vitest + Testing Library | Chat com stream simulado, inbox, painel |

Meta de cobertura: ≥ 80% de linhas nos módulos de domínio da API.

**CI (GitHub Actions):** `pnpm install --frozen-lockfile` → lint → typecheck → testes de unidade →
testes de integração e E2E → build de todos os pacotes.

---

## 10. Fases e critérios de aceite

### Fase 1 — núcleo apresentável

Inclui monorepo, core, tenancy, limits, llm, knowledge, agentes navigator/insight/predictor/risk/executor,
orchestrator, inbox, billing, watchtower, chat, web, docker compose, seed de demo e CI.

**Aceite:**
- `docker compose up` sem chaves sobe tudo; o seed cria um tenant demo, duas chaves (uma com
  `inbox:decide`), dois clientes e documentos de conhecimento.
- O fluxo completo funciona pela interface: chat em streaming → ação irreversível → aprovação →
  execução → uso e auditoria visíveis.
- Testes de RLS, de execução única e de append-only passando no CI.
- README novo com arquitetura, decisões e "defeitos corrigidos".

### Fase 2 — produtos B2B

AOPs (com agenda), market, evaluation (SEAL BR com os 42 casos), builder e os 7 agentes restantes.

**Aceite:** endpoints equivalentes aos do Python, cobrados com os mesmos tipos de trabalho e
cobertos por testes.

### Fase 3 — integrações e remoção do Python

Open Finance (Pluggy) e Sync, notificações (WhatsApp/SMTP), monitor e remoção de `legacy/python`.

**Aceite:** nenhuma funcionalidade do Python sem equivalente (checklist da tabela da seção 4) e CI
apenas TypeScript.

---

## 11. Defeitos do Python corrigidos pela migração

| # | Defeito atual | Correção |
|---|---|---|
| 1 | Executores da inbox nunca registrados; inbox em memória em produção; Executor fora do fluxo | Executor no grafo, executores registrados no boot, solicitações no Postgres (seção 6.2) |
| 2 | Ação desconhecida tratada como reversível (executa sem aprovação) | Padrão `IRREVERSIBLE` |
| 3 | Reserva de modelo só no classificador | `withFallbacks()` em todos os agentes |
| 4 | Cache de orquestradores ilimitado e histórico compartilhado entre requisições | Grafo sem estado, histórico por thread e cortado |
| 5 | Orquestrador sem síntese; documentação desatualizada | Nó `synthesize`; documentação reescrita |
| 6 | Limites e cota por processo, cota não atômica | Redis com operações atômicas |
| 7 | 500 sem tratamento; WebSocket expõe `str(exc)` | Filtro RFC 9457, eventos de erro sem detalhes internos |
| 8 | `decided_by` em texto livre | Escopo `inbox:decide` e `decided_by_key_id` |
| — | Dinheiro em `float` | `numeric(18,2)` / `Decimal` |
| — | Chave de API na URL do WebSocket | Ticket de uso único |
| — | Ferramentas de lint sem versão fixada | Lockfile com versões fixas |

---

## 12. Riscos

| Risco | Mitigação |
|---|---|
| Mudanças de API no LangChain/LangGraph | Versões fixadas; uso concentrado em `llm`, `agents` e `orchestrator` |
| Modelos `:free` do OpenRouter somem ou limitam | Modelos só no YAML; cadeia de reserva; modo mock para a demo |
| RLS mal configurada vaza dados | Papel `NOBYPASSRLS`, `FORCE RLS`, falha fechada e testes de isolamento obrigatórios no CI |
| Custo de uma transação por operação no Prisma | Aceitável para a escala da demo; medir na fase 1 e agrupar operações por requisição se precisar |
| Escopo grande | Fases com aceite próprio; a fase 1 já é apresentável sozinha |
