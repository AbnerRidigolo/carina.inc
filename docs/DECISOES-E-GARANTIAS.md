# Decisões, garantias e limitações — CARINA (fase 1)

Este documento reúne o material de referência que o [README](../README.md) resume: as decisões de
arquitetura, os defeitos do Python que foram corrigidos, cada garantia com o teste que a prova, os
pontos de segurança e as limitações conhecidas. A descrição dos processos e dos componentes está em
[ARCHITECTURE.md](ARCHITECTURE.md).

## Decisões de arquitetura

| Tema | Decisão | Alternativas descartadas (motivo) |
| --- | --- | --- |
| Organização | Monorepo **pnpm workspaces** | Nx (configuração demais para o tamanho); repositórios separados (tipos duplicados) |
| Backend | **NestJS 12** (ESM, Node 22.22.2 fixado em `.nvmrc`) | Express/Fastify puros (organização toda manual) |
| Frontend | **React + Vite** | Next.js (peças demais ao lado do NestJS); Angular |
| Dados transacionais | **PostgreSQL 17 + Prisma 7** (driver adapter `pg`) | Tudo no FalkorDB (não serve para dado transacional) |
| Conhecimento | **pgvector no mesmo Postgres**, grafo em tabelas, isolamento por **RLS** | Neo4j Community (sem controle de acesso por papel); FalkorDB (SSPL, ecossistema JS fraco) |
| Agentes | **LangGraph.js** com `interrupt()` e checkpointer Postgres | Vercel AI SDK (sem pausa durável pronta); Mastra (licença `ee/`) |
| Modelos | **LangChain.js** com `withFallbacks()` por papel; embeddings NVIDIA | LiteLLM (só Python); misturar LangChain com AI SDK |
| Cache, limites, eventos | **Redis**: TTL, sorted set + Lua (limites e cota atômicos), **Streams** com consumer groups e DLQ | Limites em memória (não valem com várias instâncias) |
| Dados de clientes | **Custo zero**: API de ingestão, gerador sintético e (fase 2) importação de arquivos, atrás de `FinancialDataProvider` | Pluggy/Belvo (a partir de R$ 1.500–2.500/mês); APIs da B3 (contrato); Open Finance direto (autorização do BC) |
| Testes | **Vitest**, Supertest, Testing Library + MSW; Postgres/Redis reais | Jest (problemas com pacotes só-ESM do NestJS 12) |
| Qualidade | TypeScript `strict` + `noUncheckedIndexedAccess`, ESLint + Prettier, versões exatas no lockfile | — |

### Onde a implementação se afastou do plano

O que foi construído difere do plano em alguns pontos. Cada mudança tem um motivo registrado:

- **Pluggy fora; `data-ingestion` no lugar.** O spec foi revisado antes da implementação por
  causa do custo. Os dados de clientes entram pela API de ingestão (lotes de até 1.000 itens,
  upsert idempotente, `data:write`) ou pelo gerador sintético. O Sync, sem LLM, os transforma em
  documentos, entidades e relações da base de conhecimento.
- **Grafo com nós `retrieve`, `respond` e `approval`.** O nó `answer` virou `respond` porque o
  LangGraph proíbe nó com o nome de um canal do estado. O executor e a aprovação ficaram em
  **dois nós**: na retomada o LangGraph reexecuta o nó do `interrupt()` desde o início, e assim a
  proposta (chamada de modelo) não roda de novo.
- **O banco decide a retomada, não o evento.** O valor do `resume` é só um sinal. O nó `approval`
  relê a `approval_request` sob RLS e só chama `executeOnce` se ela estiver `approved`.
- **Processo de workers separado.** `main.worker.ts` roda Sync, ResumeWorker e reconciliação. No
  compose a API sobe com `WORKERS_ENABLED=false`. Em desenvolvimento, `main.ts` sozinho também
  roda tudo.
- **Revalidação da chave em sockets abertos.** Um ticket vale 30 s e uma vez só (`GETDEL`).
  Antes de cada turno, o `LiveKeyService` revalida chave, escopo e tenant por id (cache de no
  máximo `API_KEY_REVALIDATE_TTL_MS`, 60 s por padrão), e a conexão tem vida máxima
  (`WS_MAX_CONNECTION_MS`). Para isso a migração 0006 criou `tenant.suspended_at` e
  `resolve_api_key_by_id`.
- **Reconciliação sem credencial de dono.** A reconciliação lista os tenants por uma função
  `SECURITY DEFINER` (`active_tenant_ids`) e processa cada um sob RLS como `carina_app`. A API e o
  worker nunca recebem a senha do `carina_migrator`.
- **Agendamento.** Em vez de `@nestjs/schedule`, um `setInterval` com lock Redis por tick
  (`ReconciliationJob`).
- **Frontend sem TanStack Query.** O estado fica no React e num barramento de eventos interno; o
  WebSocket reconecta com backoff.
- **Versão fixada por compatibilidade.** `@langchain/langgraph-sdk` está em 1.12.9 (override em
  [`pnpm-workspace.yaml`](../pnpm-workspace.yaml)), porque o 1.12.10 exige `@langchain/core` ≥ 1.3.2.
- **Node 22.22.2.** O jsdom 31 exige `^22.22.2`. O `.nvmrc` é a única fonte, e o CI, as imagens
  Docker e o `engines` seguem essa versão
  ([`toolchain.spec.ts`](../apps/api/src/toolchain.spec.ts)).

## Defeitos do Python corrigidos

| # | Defeito no Python | Correção na versão TypeScript | Onde ver |
| --- | --- | --- | --- |
| 1 | Executores da inbox nunca registrados; inbox em memória; Executor fora do fluxo | Executor é nó do grafo; `ExecutorRegistry` registra executores (simulados) no boot; solicitações e execuções no Postgres | `modules/inbox`, [`inbox.int.spec.ts`](../apps/api/test/inbox/inbox.int.spec.ts) |
| 2 | Ação desconhecida tratada como reversível (executava sem aprovação) | Listas explícitas de `READ` e `REVERSIBLE`; **qualquer outra ação é `IRREVERSIBLE`** | [`risk.spec.ts`](../apps/api/src/modules/inbox/risk.spec.ts) |
| 3 | Modelo de reserva só no classificador | `withFallbacks()` em toda cadeia de modelo, com schema e tools aplicados a cada modelo | [`model-factory.spec.ts`](../apps/api/src/modules/llm/model-factory.spec.ts) |
| 4 | Cache de orquestradores ilimitado e histórico compartilhado entre requisições | Grafo sem estado em memória; histórico por thread no checkpointer, cortado: o checkpoint guarda as últimas 40 mensagens, os nós passam as últimas 20 aos agentes, e cada chamada ao modelo usa as últimas 12 | `modules/orchestrator`, `agents/agent.ts` |
| 5 | Orquestrador sem síntese | Nó `synthesize`; a falha de um especialista vira `{agent, error}` e a síntese menciona a análise que faltou | [`graph.spec.ts`](../apps/api/src/modules/orchestrator/graph.spec.ts) |
| 6 | Limites e cota por processo; cota não atômica | Janela deslizante e cota mensal no Redis, cada uma num único script Lua | [`limits.int.spec.ts`](../apps/api/test/limits/limits.int.spec.ts) |
| 7 | 500 sem tratamento; WebSocket expunha `str(exc)` | Filtro global RFC 9457 (`application/problem+json` com `traceId`); evento WS `error` só com `code` e `traceId` | [`problem-details.filter.spec.ts`](../apps/api/src/core/errors/problem-details.filter.spec.ts), [`ws.e2e.spec.ts`](../apps/api/test/chat/ws.e2e.spec.ts) |
| 8 | `decided_by` em texto livre | Escopo `inbox:decide`; `decided_by_key_id` com FK composta (a chave tem de ser do mesmo tenant) | [`decision.e2e.spec.ts`](../apps/api/test/inbox/decision.e2e.spec.ts), [`inbox-integrity.int.spec.ts`](../apps/api/test/database/inbox-integrity.int.spec.ts) |
| — | Dinheiro em `float` | `numeric(18,2)` / `Decimal`, string decimal nos contratos; fee com arredondamento meio-para-cima | [`pricing.spec.ts`](../apps/api/src/modules/billing/pricing.spec.ts), [`billing.int.spec.ts`](../apps/api/test/billing/billing.int.spec.ts) |
| — | Chave de API na URL do WebSocket | Ticket de uso único (30 s) emitido por `POST /api/ws/ticket` | [`ws.e2e.spec.ts`](../apps/api/test/chat/ws.e2e.spec.ts) |
| — | Ferramentas de lint sem versão fixada | Versões exatas em todos os `package.json` e lockfile congelado no CI | `pnpm install --frozen-lockfile` |

## Garantias provadas por testes

Cada linha cita o arquivo e o teste que a prova. Os testes de integração e E2E rodam contra
Postgres e Redis reais (no CI, `pgvector/pgvector:pg17` e `redis:7-alpine`), conectados como
`carina_app`, que é `NOSUPERUSER NOBYPASSRLS`.

| Garantia | Teste |
| --- | --- |
| **Isolamento por RLS** entre tenants e entre clientes; fora de contexto, nada volta (falha fechada) | [`rls-isolation.int.spec.ts`](../apps/api/test/database/rls-isolation.int.spec.ts) (incl. "20 contextos em paralelo… nunca leem dados um do outro"); [`migrations.int.spec.ts`](../apps/api/test/database/migrations.int.spec.ts) ("SELECT em position sem app.tenant_id não devolve nada", "toda tabela de dados tem RLS com FORCE e política") |
| RLS na **busca vetorial/híbrida** (outro cliente do mesmo tenant e outro tenant não veem nada) | [`knowledge.int.spec.ts`](../apps/api/test/knowledge/knowledge.int.spec.ts) |
| Funções `SECURITY DEFINER` não podem ser **sombreadas por tabelas temporárias** | [`migrations.int.spec.ts`](../apps/api/test/database/migrations.int.spec.ts) (`resolve_api_key` e `resolve_api_key_by_id`), [`inbox-integrity.int.spec.ts`](../apps/api/test/database/inbox-integrity.int.spec.ts) (`active_tenant_ids`) |
| **Execução no máximo uma vez**: dois `executeOnce` em paralelo, o mesmo `resume` entregue duas vezes ou por dois workers, retomadas concorrentes do grafo | [`inbox.int.spec.ts`](../apps/api/test/inbox/inbox.int.spec.ts) ("dois em paralelo: o executor roda uma vez…"), [`resume.int.spec.ts`](../apps/api/test/orchestrator/resume.int.spec.ts) ("mesmo resume entregue duas vezes e por dois consumidores"), [`orchestrator.int.spec.ts`](../apps/api/test/orchestrator/orchestrator.int.spec.ts) ("retomadas concorrentes (duas instâncias)") |
| `started` preso vira `needs_review` e **nunca é reexecutado**; cobrança, auditoria e status revertem juntos | [`inbox.int.spec.ts`](../apps/api/test/inbox/inbox.int.spec.ts) (ReconciliationJob, "falha na cobrança…") |
| Decisões concorrentes: só uma vale; a segunda → 409 | [`inbox.int.spec.ts`](../apps/api/test/inbox/inbox.int.spec.ts), [`decision.e2e.spec.ts`](../apps/api/test/inbox/decision.e2e.spec.ts), [`full-flow.e2e.spec.ts`](../apps/api/test/flow/full-flow.e2e.spec.ts) |
| **Fluxo completo** pela fiação de produção: 403 sem `inbox:decide`, execução pelo ResumeWorker, R$ 90,00 cobrados, auditoria, inbox vazia e isolamento de um segundo tenant | [`full-flow.e2e.spec.ts`](../apps/api/test/flow/full-flow.e2e.spec.ts) |
| **Retomada entre tenants impossível**; eventos forjados não executam nada | [`orchestrator.int.spec.ts`](../apps/api/test/orchestrator/orchestrator.int.spec.ts) ("outro tenant não retoma nem lê o thread"), [`resume.int.spec.ts`](../apps/api/test/orchestrator/resume.int.spec.ts) ("eventos forjados ou venenosos…") |
| **Append-only**: em `usage_record` e `audit_event`, o INSERT do `carina_app` passa e UPDATE, DELETE e TRUNCATE falham com 42501 (permission denied) | [`migrations.int.spec.ts`](../apps/api/test/database/migrations.int.spec.ts); pelo cliente Prisma do serviço (UPDATE e DELETE recusados): [`watchtower.int.spec.ts`](../apps/api/test/watchtower/watchtower.int.spec.ts) |
| A auditoria guarda a pergunta com **CPF, CNPJ, e-mail, telefone e cartão mascarados** e truncada em 500 caracteres, e a resposta **só como digest** (nunca o texto) | [`mask-pii.spec.ts`](../apps/api/src/modules/watchtower/mask-pii.spec.ts), [`watchtower.e2e.spec.ts`](../apps/api/test/watchtower/watchtower.e2e.spec.ts) ("a pergunta gravada é mascarada…"), [`watchtower.int.spec.ts`](../apps/api/test/watchtower/watchtower.int.spec.ts) |
| **Ticket WS de uso único**; vencido ou malformado → 4401 | [`ws.e2e.spec.ts`](../apps/api/test/chat/ws.e2e.spec.ts) ("ticket reutilizado…") |
| **Chave revogada, escopo removido ou tenant suspenso com o socket aberto**: o próximo turno é recusado e o socket fecha; um socket **ocioso** é revalidado a cada heartbeat, para de receber o push da inbox e fecha com 4401 | [`ws.e2e.spec.ts`](../apps/api/test/chat/ws.e2e.spec.ts) ("Chat WebSocket: revalidação da chave e tempo máximo de vida" e "revogação com o socket ocioso") |
| A **mesma ordem pedida de novo** no mesmo thread é um pedido novo (id da aprovação inclui o turno): nova aprovação pendente, executada só depois da decisão | [`orchestrator.int.spec.ts`](../apps/api/test/orchestrator/orchestrator.int.spec.ts) ("a mesma ordem repetida no mesmo thread") |
| Aprovação `approved` **órfã** (o thread não espera por ela, conferido no checkpoint pelo worker) termina em `needs_review`, auditada, sem executar. Uma aprovação **esperada** nunca é fechada pela reconciliação: depois de 1 h segue republicada com backoff e aviso, e executa quando o worker volta. Uma espera presa por execução já terminal é curada no próximo turno, sem executar | [`resume.int.spec.ts`](../apps/api/test/orchestrator/resume.int.spec.ts) ("aprovação aprovada órfã", "aprovada e ESPERADA pelo thread além de 1 h", "execução já terminal (needs_review)", "corrida: fechamento de órfã…") |
| O broadcast da inbox só chega ao socket do **mesmo tenant e cliente** | [`ws.e2e.spec.ts`](../apps/api/test/chat/ws.e2e.spec.ts) ("broadcast da inbox") |
| **Streams**: retentativa, DLQ após 5 entregas, dedup por `eventId`, entrada inválida não derruba o loop | [`streams.int.spec.ts`](../apps/api/test/redis/streams.int.spec.ts), [`resume.int.spec.ts`](../apps/api/test/orchestrator/resume.int.spec.ts) |
| **Ingestão idempotente**: o mesmo lote duas vezes não duplica; lote cobrado ⇔ lote gravado | [`ingestion.e2e.spec.ts`](../apps/api/test/data-ingestion/ingestion.e2e.spec.ts) |
| **Limites atômicos**: 50 `reserve` concorrentes com cota 10 → exatamente 10; 429 sempre com `Retry-After` | [`limits.int.spec.ts`](../apps/api/test/limits/limits.int.spec.ts) |
| **Watchtower sem ReDoS**: tempo linear em entradas adversariais de 1 MB; paridade com o Python | [`inspect-text.perf.spec.ts`](../apps/api/src/modules/watchtower/inspect-text.perf.spec.ts), [`inspect-text.parity.spec.ts`](../apps/api/src/modules/watchtower/inspect-text.parity.spec.ts) |
| Logs **sem chave, ticket nem query string**; requisições levam `tenantId`/`keyId` | [`health.e2e.spec.ts`](../apps/api/test/health/health.e2e.spec.ts) ("logs de requisição") |
| Provedores fora: REST → 503 com `Retry-After`; WS → evento `error` sem texto interno; nos dois, cota devolvida e nada cobrado | [`chat.e2e.spec.ts`](../apps/api/test/chat/chat.e2e.spec.ts), [`ws.e2e.spec.ts`](../apps/api/test/chat/ws.e2e.spec.ts) |

## Como rodar os testes

Requisitos: Node 22.22.2 (`.nvmrc`) e pnpm 10 (`corepack enable` ou `npm i -g pnpm@10.28.0`).

```bash
pnpm install
pnpm lint && pnpm typecheck
pnpm test                              # unidade: api, shared e web
pnpm --filter @carina/api test:int     # integração (Postgres + Redis reais)
pnpm --filter @carina/api test:e2e     # E2E da API (Supertest + WebSocket, LLM_MODE=mock)
pnpm --filter @carina/api test:cov     # unit + int + e2e com cobertura (limite: 80% de linhas em src/modules)
pnpm build
```

Integração e E2E precisam de um Postgres com pgvector e de um Redis:

- **Com Docker e sem nenhuma variável**, o harness sobe `pgvector/pgvector:pg17` e
  `redis:7-alpine` via Testcontainers.
- **Com serviços próprios** (é o que o CI faz), aponte para eles:

  ```bash
  export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres  # superusuário
  export TEST_REDIS_URL=redis://localhost:6379
  ```

  O harness cria um banco novo por execução e projeto, cria os papéis `carina_migrator` e
  `carina_app` se faltarem (nunca altera papéis existentes), aplica as migrações e remove o
  banco no fim.
- **`TEST_DB_ICU_LOCALE=en-US`** (opcional, PostgreSQL ≥ 15) cria o banco de teste com
  collation ICU, para reproduzir localmente a ordenação de texto do CI (`en_US.utf8`) num
  Postgres local em `C.UTF-8`.

Cada arquivo de teste usa um DB lógico próprio do Redis
([`redis-dbs.ts`](../apps/api/test/setup/redis-dbs.ts)), e os projetos `unit` → `int` → `e2e` rodam
em sequência numa execução única.

O CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) tem três jobs:

- `typescript`: lint, typecheck, unidade, integração, E2E, cobertura e build, com service
  containers PG17 + pgvector e Redis 7;
- `compose-smoke`: `docker compose up --wait` sem chaves de API e o roteiro de aprovação pelo
  proxy do web;
- `legacy-python`: os testes da versão antiga.

## Segurança: o que saber antes de expor

Esta é uma demo de portfólio, não um serviço pronto para produção. Pontos a conhecer:

- **PII vai ao provedor de LLM no modo live.** Os prompts levam a pergunta e trechos da base de
  conhecimento do cliente (posições, transações, instituições) para OpenRouter/Groq, e os textos a
  indexar para a NVIDIA. No modo mock nada sai da máquina.
- **As chaves de demo são públicas.** Veja [Demo local](../README.md#demo-local). Gere chaves novas fora dela.
  As chaves ficam no banco só como sha256 e nunca vão para os logs.
- **Ticket do WebSocket na query string.** A chave nunca vai na URL; o ticket vai em
  `/ws/chat?ticket=…`. Ele vale 30 s e uma vez só, e o nginx da demo não grava access log de
  `/ws/`. Um reverse proxy seu deve fazer o mesmo (ou mascarar a query), porque um ticket ainda
  não usado que vaze nos logs pode abrir uma sessão dentro da janela de 30 s.
- **Sem allow-list de `Origin` no WebSocket.** O ticket é a autenticação e é obtido com a chave
  num header, que outro site não consegue ler. Mesmo assim, uma checagem de `Origin` seria defesa
  em profundidade.
- **Suspensão de tenant sem API administrativa.** `tenant.suspended_at` funciona (REST → 401;
  sockets abertos fecham no próximo turno ou heartbeat), mas hoje só se altera direto no banco.
- **O valor que define a taxa de execução é afirmado pelo modelo.** O `valueBrl` da proposta vem
  da saída do LLM. Ele é validado (formato, sinal, limite de `numeric(18,2)`) e, nas ações que
  movem dinheiro (`place_trade`, `transfer`, `rebalance`), quando o payload traz como conferir
  (valor explícito, ou quantidade × preço unitário), tem de bater, senão a proposta é recusada. O aprovador vê o valor junto com o payload antes de decidir. Não há fonte
  de preço no servidor: na fase 2 o valor deve vir de uma cotação do servidor, não do modelo.
- **CSP do web**: `connect-src 'self'`. Pela CSP Level 3, `'self'` cobre o `ws:`/`wss:` da mesma
  origem; verificamos isso no Chromium. Um navegador antigo que não siga a CSP3 bloquearia o
  WebSocket.
- O papel de runtime (`carina_app`) não tem `BYPASSRLS` e não lê `api_key`. A autenticação passa
  por funções `SECURITY DEFINER` com `search_path` fixo.

## Limitações conhecidas e próximos passos

O que **não** está feito ou tem limite conhecido na fase 1:

- **Executores simulados.** `place_trade`, `transfer` e afins devolvem ids simulados; não há
  integração com corretora. O preço do `place_trade` no mock é fixo (R$ 30,00 por ação).
- **Modo live sem teste automatizado.** A cadeia de fallback é testada com modelos falsos; os ids
  `:free` do OpenRouter em `models.yaml` têm `TODO confirmar` e podem mudar.
- **Agentes da fase 1:** navigator, insight, predictor, risk e executor. Os outros seis do Python
  ficam para a fase 2. Os docs [`AGENTS.md`](AGENTS.md), [`B2B.md`](B2B.md) e
  [`DEPLOYMENT.md`](DEPLOYMENT.md) ainda descrevem a versão Python e a visão de produto.
- **Conversa guardada no checkpoint.** O schema `langgraph` guarda as mensagens da conversa
  (perguntas e respostas, em texto) sem RLS (são tabelas da biblioteca), sem TTL e sem limpeza em
  cascata por cliente. O thread é `tenant:cliente:uuid`, e a API nunca expõe nem retoma thread de
  outro tenant, mas os dados ficam lá.
- **Sem caminho de eliminação (LGPD).** Não há rota nem rotina para apagar os dados de um cliente
  final (posições, transações, conhecimento, checkpoints). A auditoria é append-only por desenho.
- **Mascaramento de PII por padrões.** A pergunta auditada tem CPF, CNPJ, e-mail, telefone e
  cartão mascarados; nomes, endereços e PII em formato livre continuam passando. No modo live, o
  contexto do cliente vai ao provedor de LLM (ver [Segurança](#segurança-o-que-saber-antes-de-expor)).
- **Re-sync completo por lote.** Cada lote de ingestão dispara um Sync completo do cliente (sem
  coalescência), o que custa caro num backfill grande.
- **Auditoria com o uuid interno do cliente.** `GET /api/audit` devolve o `clientId` interno,
  enquanto as outras rotas usam o `externalId`.
- **Turno que termina depois de o cliente desconectar** é cobrado, mas a resposta não pode ser
  recuperada pela API.
- **Streams sem `MAXLEN`.** `jobs`, `inbox.events` e as DLQs crescem sem limite.
- **Atualização após aprovar.** Na UI, o painel de uso só se atualiza no fim de um turno de chat
  ou pelo botão "Atualizar", não quando chega `approval_executed`.
- **Uma instância só foi exercitada na demo.** Réplicas são seguras por desenho e por teste
  (consumidores concorrentes, locks), mas não houve teste de carga.

Próximos passos de engenharia, em ordem de prioridade:

1. API administrativa para suspender tenant e revogar chave (hoje, só direto no banco).
2. `MAXLEN`/trim dos streams e offset inicial dos consumer groups.
3. Nomes de consumer estáveis por réplica, ou `XGROUP DELCONSUMER` dos ociosos (hoje cada
   processo cria um nome novo).
4. Mapear erros do Prisma/Postgres (42501, P2002, classe 22) para Problem Details específicos, em
   vez de 500 genérico.
5. Limite para a criação de `client`: hoje cada `clientId` novo num ticket ou chat cria um cliente.
6. `MODELS_CONFIG_PATH` dentro do `EnvSchema` (hoje é lida fora da validação).
7. Reconciliação: trocar as políticas SELECT da migração 0004 (por `current_user`/`session_user`)
   por um papel dedicado `carina_reconciler`, ou cobri-las com um teste de catálogo.
8. Remover código morto restante: `ExecutorAgent.request`, `INSTITUTIONS`,
   `MODEL_FACTORY_OPTIONS`.
9. Alinhar a classe de erro do modo mock (`ValidationError`) com a do live
   (`AllProvidersFailedError`) para saída fora do schema.

