# Agentes restantes (Fase 2, entrega 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quatro especialistas novos no chat (strategist, tax, researcher, assessor_liaison) e categorização determinística das transações gravadas.

**Architecture:** Os especialistas são `LlmAgent` como insight/predictor/risk: prompt em `prompts.ts`, schema Zod em `packages/shared`, `refine` em `output-limits.ts`, responder determinístico no modo mock, registro no `AgentRegistry`, palavras-chave na heurística e cartão na web. O categorizer é uma função pura chamada pelo `IngestionService` antes de gravar transações sem categoria.

**Tech Stack:** NestJS 12 ESM, LangGraph.js, Zod 4 (`packages/shared`), Vitest unit/int/e2e, React + Vite.

**Spec:** `docs/superpowers/specs/2026-11-19-agentes-restantes-design.md`

## Global Constraints

- Ordem fixa dos especialistas: `insight`, `risk`, `predictor` (ordem atual da heurística), depois `strategist`, `tax`, `researcher`, `assessor_liaison`.
- No máximo **3** especialistas por turno (`MAX_SPECIALISTS = 3`), na heurística e em `normalizePlan`.
- Limites de saída: os de `output-limits.ts` (`MAX_ITEM_CHARS` 500, `MAX_NARRATIVE_CHARS` 5000, `MAX_LIST_ITEMS` 20); `AssessorBrief.questions` 1..5; soma de `targetAllocation` = 100 ± 0,5; probabilidades em 0..1; `estimatedTaxBrl` ≥ 0.
- Toda REGRA de prompt termina com `withNotice` (aviso de conteúdo não confiável).
- Researcher nunca diz que pesquisou na web; assessor_liaison nunca diz que enviou algo.
- Categorizer: sem LLM, nunca sobrescreve `category` enviada, sem casamento → `null`.
- Sem tipo de trabalho de cobrança novo; sem migração de banco.
- Cada tarefa roda, antes do commit: `pnpm lint` (ignorar só os arquivos não rastreados em `.playwright-mcp/`), `pnpm typecheck`, `pnpm test`; as tarefas que tocam orquestrador ou ingestão rodam também `test:int` e `test:e2e` da API (Postgres 16 com pgvector e Redis locais, `TEST_DATABASE_URL`/`TEST_REDIS_URL`).
- Textos, comentários, nomes de teste e commits em português, no tom do repositório.

## Review Focus

1. **Pergunta que casa várias áreas novas e antigas** ("imposto, risco, aposentadoria, projeção e pergunte ao assessor"): roda só 3 especialistas, na ordem fixa. → Task 3 ("corta em 3 na ordem fixa").
2. **Palavra-chave curta dentro de outra palavra** ("metade", "cometa", "irmão", "assessoria" vs "assessor"): `meta` e `ir` não acionam strategist/tax por substring. → Task 3 ("limite de palavra").
3. **Modelo devolve alocação que não soma 100 ou probabilidade 1.5**: a saída é recusada (`AllProvidersFailedError`) e a síntese avisa que a análise falhou. → Task 2.
4. **Descrição com acento decomposto ou caixa alta** ("FARMÁCIA" em NFD, "Uber*Trip"): categoriza igual à forma simples; "99" não casa em "R$ 199,00". → Task 5.
5. **A mesma transação reenviada, uma vez sem categoria e outra com**: o upsert grava o que vem no último envio (com categoria → a enviada; sem → a inferida). "Nunca sobrescreve" vale para o item do lote, não para o histórico; a limitação vai para a documentação. → Task 5 ("reenvio com e sem categoria").

---

### Task 1: Schemas compartilhados dos especialistas novos

**Files:**
- Modify: `packages/shared/src/agents.ts`, `packages/shared/src/agents.spec.ts`

**Interfaces:**
- Produces (exportados de `@carina/shared`):
  - `StrategyPlanSchema` / `StrategyPlan`: `{ targetAllocation: { assetClass: string; pct: number }[] (min 1); milestones: { goal: string; byYear: number (int 2000..2200); successProbability: number (0..1) }[]; assumptions: string[]; narrative: string }`
  - `TaxAdviceSchema` / `TaxAdvice`: `{ estimatedTaxBrl: Money; harvestingOpportunities: string[]; offshoreVsBr: string; actions: string[]; consultAccountant: boolean; narrative: string }`
  - `AssessorBriefSchema` / `AssessorBrief`: `{ questions: string[] (1..5); sharedData: string[]; narrative: string }`
- Os enums `SpecialistNameSchema`/`AgentNameSchema` NÃO mudam aqui (Task 2), para o typecheck ficar verde.

- [ ] **Step 1: Write the failing tests** em `agents.spec.ts`: "StrategyPlan aceita plano válido e recusa pct não numérico e alocação vazia"; "StrategyPlan recusa successProbability 1.5 e byYear 1999"; "TaxAdvice exige Money em estimatedTaxBrl e consultAccountant boolean"; "AssessorBrief exige de 1 a 5 perguntas".
- [ ] **Step 2: Run** `pnpm --filter @carina/shared test` → FAIL (schemas não existem).
- [ ] **Step 3: Implement** os três schemas em `agents.ts`.
- [ ] **Step 4: Run** `pnpm --filter @carina/shared test` e `pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(shared): schemas do strategist, tax e assessor_liaison`

### Task 2: Os quatro agentes, registro e modo mock

**Files:**
- Create: `apps/api/src/modules/agents/strategist.ts`, `tax.ts`, `researcher.ts`, `assessor-liaison.ts`
- Modify: `packages/shared/src/agents.ts` (+spec), `apps/api/src/modules/agents/prompts.ts`, `output-limits.ts`, `agent-registry.ts`, `mock-responders.ts`, `agents.spec.ts`, `apps/api/src/modules/orchestrator/orchestrator.service.ts` (filtro do `agent_result`), `apps/web/src/features/chat/AgentCard.tsx` (só `AGENT_LABELS`)

**Interfaces:**
- Consumes: Task 1 (schemas).
- Produces:
  - `SpecialistNameSchema = z.enum(["insight", "predictor", "risk", "strategist", "tax", "researcher", "assessor_liaison"])`; `AgentNameSchema` = esses + `navigator`, `executor`.
  - `createStrategist(models, logger): LlmAgent<StrategyPlan>` (role `reasoning`), `createTax(...): LlmAgent<TaxAdvice>` (`reasoning`), `createResearcher(...): LlmAgent<string>` (`conversational`, sem schema), `createAssessorLiaison(...): LlmAgent<AssessorBrief>` (`conversational`).
  - `refineStrategy(p: StrategyPlan): StrategyPlan`, `refineTax(t: TaxAdvice): TaxAdvice`, `refineAssessorBrief(b: AssessorBrief): AssessorBrief` em `output-limits.ts` (mesmo estilo de `refineRisk`; `checkMoney(estimatedTaxBrl, { nonNegative: true })`; soma de pct 100 ± 0,5 e cada pct em 0..100 finito).
  - `PROMPTS.strategist`, `PROMPTS.tax`, `PROMPTS.researcher`, `PROMPTS.assessor_liaison`; o prompt do Navigator cita os sete especialistas; remover do comentário do topo a frase "nem ao Tax (não existe nesta fase)".
  - `AGENT_LABELS` na web: `strategist: "Strategist"`, `tax: "Tributário"`, `researcher: "Pesquisa"`, `assessor_liaison: "Assessor"`.
  - No `orchestrator.service.ts`, o `case "specialist"` emite `agent_result` para toda chave que passar em `SpecialistNameSchema.safeParse`.

Prompts: portar de `legacy/python/carina/agents/tier1/{strategist,researcher,assessor_liaison}.py` e `tier3/tax_optimizer.py` com as mudanças do spec §4.2 (sem grafo/Modal/Hermes/`<think>`; researcher: "você NÃO tem acesso à web… se a base não tiver a resposta, diga isso"; assessor_liaison: "você só redige; nada é enviado; liste em sharedData o que cada pergunta revela"; tax/strategist: estimativa explícita e quando consultar um contador/planejador; nenhum executa). Mock: responders determinísticos válidos nos schemas, que citam o título da primeira `<fonte>` do contexto quando houver (researcher sem fonte responde que a base não tem a informação).

- [ ] **Step 1: Write the failing tests** em `agents.spec.ts` (padrão dos testes do risk/predictor): "strategist no mock devolve StrategyPlan válido"; "strategist recusa alocação que soma 90 → AllProvidersFailedError"; "strategist recusa successProbability fora de 0..1" (via refine com saída forjada do modelo, como nos testes do risk); "tax recusa estimatedTaxBrl negativo"; "assessor_liaison recusa 6 perguntas e item com 501 caracteres"; "researcher no mock cita o título da primeira fonte e não menciona web"; "researcher sem fonte diz que a base não tem a informação"; "todos os prompts novos terminam com o aviso de conteúdo não confiável"; "prompt do researcher diz que não tem acesso à web"; "o registro devolve os quatro agentes novos com o papel certo". Em `packages/shared/src/agents.spec.ts`: "AgentName inclui os quatro especialistas novos".
- [ ] **Step 2: Run** `pnpm --filter @carina/api test -- agents` → FAIL.
- [ ] **Step 3: Implement** enums, prompts, refines, quatro arquivos, registro, mocks, filtro do orquestrador e rótulos da web.
- [ ] **Step 4: Run** `pnpm typecheck`, `pnpm test`, `test:int` e `test:e2e` da API → PASS.
- [ ] **Step 5: Commit** `feat(agents): strategist, tax, researcher e assessor_liaison`

### Task 3: Classificação com os sete especialistas e limite de 3 por turno

**Files:**
- Modify: `apps/api/src/modules/orchestrator/heuristic.ts`, `heuristic.spec.ts`
- Test: `apps/api/test/chat/chat.e2e.spec.ts`

**Interfaces:**
- Consumes: Task 2 (`SpecialistName` com sete nomes, agentes registrados).
- Produces: `export const MAX_SPECIALISTS = 3` em `heuristic.ts`; `heuristicPlan` e `normalizePlan` cortam em `MAX_SPECIALISTS` na ordem fixa; `CLASSIFIER_PROMPT` lista os sete com uma linha cada e diz "no máximo 3".

Palavras-chave (spec §4.3). Termos curtos ou ambíguos casam com limite de palavra (regex `(^|[^\p{L}\p{N}])termo([^\p{L}\p{N}]|$)` com flag `u`), não substring: `ir`, `meta`, `metas`, `darf`, `fonte`. Os demais seguem como substring, como hoje. `assessor` casa "assessor" e "assessora", não "assessoria" (limite de palavra com sufixo opcional `a`).

- [ ] **Step 1: Write the failing tests** em `heuristic.spec.ts`: "imposto/IR/DARF → tax"; "aposentadoria e meta → strategist"; "pesquise na base/o que diz a fonte → researcher"; "pergunte ao assessor → assessor_liaison"; "limite de palavra: metade, cometa, irmão, assessoria não acionam ninguém"; "corta em 3 na ordem fixa: imposto + risco + aposentadoria + projeção + assessor → [risk, predictor, strategist]"; "normalizePlan corta em 3 e mantém a ordem do modelo depois de deduplicar"; "o prompt do classificador lista os sete especialistas". E2E em `chat.e2e.spec.ts` (mock): "pergunta de imposto: plano com tax, agent_result válido em TaxAdviceSchema e síntese"; "pergunta que casa 5 áreas roda só 3 especialistas (3 agent_started de especialista)".
- [ ] **Step 2: Run** `pnpm --filter @carina/api test -- heuristic` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `pnpm test`, `test:int` e `test:e2e` da API → PASS.
- [ ] **Step 5: Commit** `feat(orchestrator): classificação com os sete especialistas, no máximo 3 por turno`

### Task 4: Cartões na web

**Files:**
- Modify: `apps/web/src/features/chat/AgentCard.tsx`, `AgentCard.module.css`, `ChatView.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–2 (`StrategyPlanSchema`, `TaxAdviceSchema`, `AssessorBriefSchema`, rótulos).
- Produces: `Result` renderiza `strategist` (tabela classe/% e lista de marcos com ano e probabilidade em %), `tax` (IR estimado formatado em R$ com `formatBrl` ou o formatador que os outros cartões usam, oportunidades, ações, e o aviso "Consulte um contador antes de agir." quando `consultAccountant`), `assessor_liaison` (perguntas numeradas, cada uma com o que revela, e o aviso "Rascunho: nada foi enviado ao assessor."), `researcher` como texto. Resultado que não passa no schema cai no render genérico existente.

- [ ] **Step 1: Write the failing tests** em `ChatView.test.tsx` (padrão dos testes do predictor/risk): "cartão do strategist mostra a alocação e os marcos"; "cartão tributário mostra o IR em R$ e o aviso de contador só com consultAccountant"; "cartão do assessor numera as perguntas e avisa que nada foi enviado"; "cartão de pesquisa mostra o texto"; "resultado fora do schema cai no render genérico".
- [ ] **Step 2: Run** `pnpm --filter @carina/web test` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `pnpm --filter @carina/web test` e `pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(web): cartões do strategist, tributário, pesquisa e assessor`

### Task 5: Categorizer determinístico na ingestão

**Files:**
- Create: `apps/api/src/modules/data-ingestion/categorize.ts`, `categorize.spec.ts`
- Modify: `apps/api/src/modules/data-ingestion/ingestion.service.ts`
- Test: `apps/api/test/data-ingestion/ingestion.int.spec.ts`, `apps/api/test/imports/imports.int.spec.ts`

**Interfaces:**
- Produces:
  - `categorize(description: string, kind: NormalizedTransaction["kind"]): string | null`
  - `withInferredCategories(items: readonly NormalizedTransaction[]): NormalizedTransaction[]` — mantém `category` quando presente e não vazia; senão usa `categorize`; `null` → deixa sem `category`.
  - `IngestionService.upsertTransactions` e `upsertTransactionsFor` passam os itens por `withInferredCategories` antes do repositório.

Regras: `kind` primeiro (`buy`, `sell`, `dividend`, `jcp` → `investimento`; `tax` → `impostos`; `fee` → `tarifas`); depois palavras do Python (`legacy/python/carina/agents/tier2/categorizer.py`, `_RULES`, mesma ordem de categorias), comparando descrição e palavras em minúsculas, NFD sem marcas combinantes (`\p{M}`). Palavras com até 3 caracteres (`99`, `xp`, `b3`, `cdb`, `luz`) só com limite de palavra; as demais por substring.

- [ ] **Step 1: Write the failing tests**: unidade (`categorize.spec.ts`, tabela): "FARMÁCIA em NFD → saúde"; "Uber*Trip → transporte"; "R$ 199,00 não casa 99"; "Corrida 99 → transporte"; "dividend sem descrição útil → investimento"; "tax → impostos e fee → tarifas"; "Aluguel de março → moradia"; "texto sem regra → null"; "withInferredCategories mantém a categoria enviada e não inventa 'outros'". Int (`ingestion.int.spec.ts`): "transação sem categoria é gravada com a inferida; com categoria enviada, a enviada prevalece" e "reenviar o lote sem categoria grava a inferida de novo (idempotente)"; "reenvio com e sem categoria: vale a do último envio". Int (`imports.int.spec.ts`): "OFX importado sai com categorias inferidas onde a regra casa" (fixture existente; conferir a coluna `category`).
- [ ] **Step 2: Run** `pnpm --filter @carina/api test -- categorize` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `pnpm test`, `test:int` e `test:e2e` da API → PASS.
- [ ] **Step 5: Commit** `feat(data-ingestion): categorização determinística das transações`

### Task 6: Documentação

**Files:**
- Modify: `README.md` (lista de agentes e roadmap: os seis viram "quatro de chat + categorizer feitos; monitor na entrega 2"), `docs/ARCHITECTURE.md` (agentes, classificação com limite de 3, categorizer na ingestão), `docs/DECISOES-E-GARANTIAS.md` (decisões do spec §2–5 na tabela de decisões; garantias com os nomes exatos dos testes das Tasks 2, 3 e 5; limitações: researcher sem web, assessor sem envio, categorizer só por regras e sem parcelas, monitor pendente)

- [ ] **Step 1: Write** as mudanças, citando só testes que existem (conferir cada título com `grep`).
- [ ] **Step 2: Run** `npx prettier --check` nos arquivos e um checador de links relativos e âncoras do Markdown (o da Task 13 da importação, se existir no histórico, ou um script curto) → sem link quebrado.
- [ ] **Step 3: Commit** `docs(agents): agentes restantes e categorizer no README, arquitetura e garantias`
