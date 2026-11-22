# Monitor de carteira Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Job no worker que, com o pregão aberto, detecta movimento forte nos ativos das carteiras, grava um alerta por cliente/ativo/dia/sentido e o entrega pelo WebSocket, pela API e num painel na web.

**Architecture:** Módulo novo `apps/api/src/modules/monitor` com `detectMove` (puro), `MonitorRepository` (função SECURITY DEFINER para tenants, leitura das posições e insert idempotente sob RLS) e `MonitorJob` (padrão `ImportCleanupJob`: intervalo, lock Redis, CLOCK). Cotações por um terceiro orçamento do `MarketService`. Evento `monitor.alert` em `inbox.events`, convertido em `portfolio_alert` pelo `InboxBroadcast`; rota de leitura paginada; painel na web.

**Tech Stack:** NestJS 12 ESM, Prisma 7 com RLS, Zod 4 (`packages/shared`), Redis (lock, cursor, orçamento, streams), Vitest unit/int/e2e, React + Vite.

**Spec:** `docs/superpowers/specs/2026-11-21-monitor-carteira-design.md`

## Global Constraints

- Env (validadas em `apps/api/src/core/config/env.ts`, documentadas em `.env.example`): `MONITOR_INTERVAL_MS` padrão **600000**, mínimo **60000**; `MONITOR_MAX_SYMBOLS_PER_TICK` padrão **10** (1..200); `MONITOR_MOVE_THRESHOLD_PCT` padrão **5** (1..50); `MARKET_MONITOR_MAX_CALLS_PER_MIN` padrão **10** (1..10000).
- Chaves Redis: lock `monitor:tick`; cursor `monitor:<modo>:cursor`; orçamento `market:<modo>:budget:monitor:<minuto>`.
- Só roda com `marketStateAt(now) === "open"`; alerta só de cotação do mesmo dia de São Paulo que o pregão do ciclo e com idade até `MARKET_QUOTE_MAX_AGE_MS`, `source` do modo e `changePct` não nulo.
- Um alerta por `(tenant_id, client_id, asset_code, trading_day, direction)`; `trading_day` é a data em `America/Sao_Paulo`.
- Sem LLM, sem cobrança, sem audit novo. Logs só com ids e contagens.
- Texto do alerta na web: "<ATIVO> caiu|subiu <X>% hoje (R$ <preço>)." quando o `tradingDay` do alerta é hoje em São Paulo, senão "<ATIVO> caiu|subiu <X>% em DD/MM (R$ <preço>)."; estado vazio "Nenhum alerta."; e o rodapé fixo "Variação do dia em relação ao fechamento anterior. Não é recomendação de investimento."
- Cada tarefa roda, antes do commit: `pnpm lint` (ESLint limpo; sem `!` não-nulo), `pnpm typecheck`, `pnpm test`; tarefas que tocam banco, worker ou API rodam também `test:int` e `test:e2e` da API (Postgres 16 com pgvector e Redis locais, `TEST_DATABASE_URL`/`TEST_REDIS_URL`).
- Português em textos, comentários, testes e commits.
- Redis de teste: escolher DBs livres em `apps/api/test/setup/redis-dbs.ts` para os specs novos.

## Review Focus

1. **Ativo com variação exatamente no limite (5,00%) e −5,00%**: alerta nos dois. → Task 3.
2. **Dois ciclos no mesmo dia, e virada do dia** (23:59 → 00:01 em São Paulo, com o mercado reaberto no dia seguinte): o segundo ciclo do mesmo dia não duplica; o do dia seguinte alerta de novo. → Task 4.
3. **Carteiras com mais ativos que o limite por ciclo** (45 ativos, limite 20): três ciclos cobrem todos, sem pular nem repetir antes de dar a volta. → Task 4.
4. **Orçamento do monitor esgotado** com rotas e preço livres: o ciclo para sem erro, e as rotas/preço continuam com o orçamento deles intacto. → Task 2.
5. **Cliente de outro tenant**: não recebe o evento no WebSocket e `GET /alerts` dá 404. → Task 5.

---

### Task 1: Contratos compartilhados

**Files:**
- Modify: `packages/shared/src/market.ts` (ou novo `monitor.ts` exportado no `index.ts`), `packages/shared/src/chat.ts`, `packages/shared/src/ingestion.ts` (ou onde ficam os `StreamEvent` de `inbox.events`), specs correspondentes

**Interfaces:**
- Produces: `PortfolioAlertSchema` / `PortfolioAlert` `{ id: uuid; assetCode: string; direction: "up" | "down"; changePct: SignedDecimal; price: Price; tradingDay: iso date; createdAt: iso datetime }`; `PortfolioAlertPageSchema` `{ items: PortfolioAlert[]; nextCursor: string | null }`; `ChatEvent` ganha `{ type: "portfolio_alert"; alert: PortfolioAlert }`; `StreamEvent` ganha `{ type: "monitor.alert"; tenantId: uuid; clientId: uuid; alert: PortfolioAlert }`.

- [ ] **Step 1: Write the failing tests**: "PortfolioAlert aceita alerta válido e recusa direction fora de up/down"; "changePct e price são strings decimais (número cru é recusado)"; "ChatEvent aceita portfolio_alert"; "StreamEvent aceita monitor.alert e recusa sem tenantId".
- [ ] **Step 2: Run** `pnpm --filter @carina/shared test` → FAIL.
- [ ] **Step 3: Implement**, reutilizando `SignedDecimalSchema`/`PriceSchema` de `market.ts`.
- [ ] **Step 4: Run** `pnpm --filter @carina/shared test`, `pnpm typecheck` → PASS (se algum `switch` exaustivo sobre `ChatEvent`/`StreamEvent` quebrar, tratar o caso novo como no-op e listar no relatório).
- [ ] **Step 5: Commit** `feat(shared): contratos do alerta de carteira`

### Task 2: Orçamento do monitor no MarketService e variáveis de ambiente

**Files:**
- Modify: `apps/api/src/core/config/env.ts` (+spec), `.env.example`, `apps/api/src/modules/market/market.service.ts` (+spec)

**Interfaces:**
- Produces: as quatro env do Global Constraints; `MarketService.monitorQuotes(symbols: string[]): Promise<{ quotes: Quote[]; exhausted: boolean }>` — payer `"monitor"` com o orçamento `MARKET_MONITOR_MAX_CALLS_PER_MIN`; acerto de cache não consome; orçamento esgotado → devolve o que já tinha (cache + buscado) com `exhausted: true`, nunca lança `MarketDataBusyError`; Redis fora → lança (o job pula o ciclo).

- [ ] **Step 1: Write the failing tests**: env "MONITOR_*: padrões e limites" (cada mínimo/máximo recusado); market "monitorQuotes usa orçamento próprio: esgotá-lo não afeta quotes nem priceFor"; "monitorQuotes com orçamento esgotado devolve o cache e exhausted=true, sem lançar"; "acerto de cache não consome o orçamento do monitor".
- [ ] **Step 2: Run** os specs → FAIL.
- [ ] **Step 3: Implement** (estender `Payer` com `"monitor"`, mesma chave/EVAL do orçamento com o sufixo `monitor`).
- [ ] **Step 4: Run** `pnpm test`, `test:int`, `test:e2e` → PASS.
- [ ] **Step 5: Commit** `feat(market): orçamento separado para o monitor de carteira`

### Task 3: Migração, repositório e regra

**Files:**
- Create: `apps/api/prisma/migrations/0009_portfolio_alert/migration.sql`, `apps/api/src/modules/monitor/detect-move.ts` (+spec), `apps/api/src/modules/monitor/monitor.repository.ts`
- Modify: `apps/api/prisma/schema.prisma`, módulo/core module novo `monitor-core.module.ts`
- Test: `apps/api/test/monitor/monitor.int.spec.ts`

**Interfaces:**
- Produces:
  - `detectMove(quote: Quote, rule: { thresholdPct: number; mode: "live" | "mock"; nowMs: number; tradingDay: string; maxAgeMs: number }): { direction: "up" | "down"; changePct: string; price: string } | null`
  - `MonitorRepository.tenantIds(): Promise<string[]>` (via `monitor_tenant_ids()`, SECURITY DEFINER, dono `carina_migrator`, EXECUTE só para `carina_app`, ignora tenant com `suspended_at`)
  - `MonitorRepository.watchList(tx): Promise<{ clientId: string; assetCode: string }[]>` (sob RLS; `kind = 'investment'`, `asset_code` não nulo, distintos, `asset_code` em maiúsculas sem espaços)
  - `MonitorRepository.insertIfNew(tx, row: { clientId; assetCode; direction; changePct; price; tradingDay }): Promise<PortfolioAlert | null>` (`ON CONFLICT DO NOTHING RETURNING`)
  - `MonitorRepository.list(tx, clientId: string, cursor: string | null, limit: number): Promise<PortfolioAlertPage>`
  - Tabela como no spec §4.3, RLS com FORCE no padrão das migrações 0007/0008.

- [ ] **Step 1: Write the failing tests**: unidade (`detect-move.spec.ts`): "5,00% e −5,00% alertam (limite inclusivo)"; "4,99% não alerta"; "changePct nulo, mercado fechado ou source de outro modo → null". Int: "insertIfNew grava uma vez por dia e sentido; segundo insert devolve null"; "mesmo ativo, sentido oposto no mesmo dia grava"; "RLS: tenant B não lê nem insere alerta de cliente de A"; "apagar o cliente apaga os alertas (cascade)"; "tenantIds ignora tenant suspenso e tenant sem posição de investimento"; "watchList só traz investment com asset_code"; "list pagina do mais novo para o mais antigo com cursor".
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `pnpm test`, `test:int`, `test:e2e` → PASS.
- [ ] **Step 5: Commit** `feat(monitor): tabela de alertas, repositório e regra de variação`

### Task 4: MonitorJob

**Files:**
- Create: `apps/api/src/modules/monitor/monitor.job.ts` (+spec)
- Modify: `apps/api/src/modules/monitor/monitor-core.module.ts`, `apps/api/src/worker.module.ts`, comentário do topo de `docker-compose.yml` (lista do que o worker roda)
- Test: `apps/api/test/monitor/monitor.int.spec.ts`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces: `MonitorJob.runOnce(): Promise<{ skipped: boolean; closed: boolean; tenants: number; symbols: number; alerts: number; exhausted: boolean }>`; constantes `MONITOR_LOCK_KEY = "monitor:tick"`, `monitorCursorKey(modo) = "monitor:<modo>:cursor"`. Publica `monitor.alert` em `inbox.events` para cada alerta inserido, depois do COMMIT. Logger por token `MONITOR_LOGGER`.

Rodízio: símbolos distintos ordenados; o cursor guarda o último símbolo cotado; o ciclo pega os próximos `MONITOR_MAX_SYMBOLS_PER_TICK` depois dele, dando a volta ao fim da lista; se o orçamento esgotar, o cursor avança só até o último cotado.

- [ ] **Step 1: Write the failing tests**: unidade: "fora do pregão não cota nem lê posições (closed=true)"; "lock tomado por outra réplica → skipped"; "rodízio: 45 símbolos, limite 20 → três ciclos cobrem todos, na ordem, e o quarto recomeça"; "orçamento esgotado no meio: cursor para no último cotado, sem erro"; "falha num tenant é logada (só ids) e os demais seguem"; "nenhum log contém valor de posição". Int: "ciclo com dois tenants e cotação forjada de −6% grava alertas sob o tenant certo e publica monitor.alert"; "segundo ciclo no mesmo dia não duplica nem publica de novo"; "virada do dia em São Paulo alerta de novo".
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (padrão de `import-cleanup.job.ts`: intervalo unref, CLOCK, parada esperando o ciclo).
- [ ] **Step 4: Run** `pnpm test`, `test:int`, `test:e2e` → PASS.
- [ ] **Step 5: Commit** `feat(monitor): job de vigilância da carteira no worker`

### Task 5: Rota de leitura e evento no WebSocket

**Files:**
- Create: `apps/api/src/modules/monitor/monitor.controller.ts`, `monitor.module.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/modules/chat/inbox-broadcast.ts` (+spec)
- Test: `apps/api/test/monitor/monitor.e2e.spec.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4.
- Produces: `GET /api/clients/:clientId/alerts?cursor=&limit=` (escopo `chat`, `limit` 1..50 padrão 20, cursor inválido → 422, cliente inexistente no tenant → 404, sem cobrança) → `PortfolioAlertPage`. `InboxBroadcast` converte `monitor.alert` em `{ type: "portfolio_alert", alert }` para os assinantes da chave `(tenantId, clientId)`, sem ler o banco, na cadeia por chave.

- [ ] **Step 1: Write the failing tests**: e2e: "GET /alerts lista do mais novo, pagina com cursor"; "cliente de outro tenant → 404"; "chave sem escopo chat → 403"; "limit 51 → 422"; "WebSocket recebe portfolio_alert do próprio cliente e não o de outro cliente/tenant". Unidade do broadcast: "monitor.alert vira portfolio_alert só para a chave do evento".
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `pnpm test`, `test:int`, `test:e2e` → PASS.
- [ ] **Step 5: Commit** `feat(monitor): rota de alertas e evento no WebSocket`

### Task 6: Painel na web

**Files:**
- Create: `apps/web/src/features/alerts/AlertsPanel.tsx`, `AlertsPanel.module.css`, `AlertsPanel.test.tsx`
- Modify: o ponto onde os painéis existentes (importação, uso) são montados; o cliente da API da web; o consumo de `ChatEvent` do WebSocket

**Interfaces:**
- Consumes: Tasks 1, 5.
- Produces: painel "Alertas da carteira": busca `GET /alerts` ao abrir, mostra os novos `portfolio_alert` no topo sem duplicar (por `id`), "Carregar mais" com `nextCursor`, estado vazio "Nenhum alerta.", texto e rodapé do Global Constraints, valores com o formatador de R$ e % que a web já usa.

- [ ] **Step 1: Write the failing tests**: "lista os alertas da API com o texto fixo"; "alerta ao vivo entra no topo e não duplica um já listado"; "carregar mais usa o cursor"; "estado vazio"; "rodapé diz que não é recomendação".
- [ ] **Step 2: Run** `pnpm --filter @carina/web test` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `pnpm --filter @carina/web test`, `pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(web): painel de alertas da carteira`

### Task 7: Documentação

**Files:**
- Modify: `README.md` (monitor no resumo e no roadmap), `docs/ARCHITECTURE.md` (job, orçamento, tabela, eventos, rota), `docs/DECISOES-E-GARANTIAS.md` (decisões do spec §3–4; garantias com os nomes exatos dos testes das Tasks 2–5; limitações: sem notícias, sem volume, sem canal externo, limite único por instância, dados de 60 s de cache)

- [ ] **Step 1: Write**, citando só testes que existem (conferir cada título com `grep`).
- [ ] **Step 2: Run** `npx prettier --check` nos arquivos e um checador de links relativos e âncoras → sem quebra.
- [ ] **Step 3: Commit** `docs(monitor): monitor de carteira no README, arquitetura e garantias`
