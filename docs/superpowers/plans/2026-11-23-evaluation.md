# Evaluation (SEAL BR) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Benchmark SEAL BR: catálogo sem gabarito e correção determinística de respostas submetidas pelo tenant, com Watchtower e cobrança `evaluation`.

**Architecture:** Módulo `apps/api/src/modules/evaluation` com o dataset (42 casos portados), o motor puro (`normalize`, `gradeCase`, `evaluate`) e um controller com duas rotas; contratos públicos em `packages/shared/src/evaluation.ts` sem campos de gabarito.

**Tech Stack:** NestJS 12 ESM, Zod 4, Vitest unit/e2e.

**Spec:** `docs/superpowers/specs/2026-11-23-evaluation-design.md`

## Global Constraints

- Fonte: `legacy/python/carina/data_engine/{evaluation,eval_dataset}.py`, `legacy/python/tests/test_eval.py`, rotas `/eval/*` em `legacy/python/carina/api/routes.py`. Conteúdo dos 42 casos copiado sem alteração.
- Gabarito (`expectedFacts`, `forbidden`, `reference`) só em `apps/api`; nunca em `packages/shared`, resposta HTTP, erro, log ou auditoria.
- `normalize`: minúsculas, `,` → `.`, NFKD sem marcas combinantes, espaços colapsados — igual ao Python. `score`, `passRate`, `avgScore` com 4 casas (arredondamento igual ao `round` do Python para os casos testados).
- Limites do corpo: `answers` com 1..42 entradas; cada resposta ≤ 20 000 caracteres; ids desconhecidos → 422 listando-os.
- Escopo novo `eval:run`; o seed dá `eval:run` à chave de demo que tem `data:write`.
- Cobrança: `evaluation` (preço já em `pricing.ts`), uma por submissão corrigida, `clientId` nulo; 422 não cobra; catálogo não cobra.
- Antes de cada commit: `pnpm lint` (ESLint limpo; sem `!`), `pnpm typecheck`, `pnpm test` (o teste de estouro de memória de `parse-file.spec.ts` falha só localmente pelo Node 22.23.4; ignorar só esse), e na Task 2 `test:int`/`test:e2e` da API (Postgres + Redis locais).
- Português em textos, comentários, testes e commits.

## Review Focus

1. **Resposta com acento decomposto e vírgula decimal** ("22,5%" em NFD) casa a alternativa "22.5%". → Task 1.
2. **Resposta enorme ou 43 casos**: 422 antes de corrigir, sem cobrança. → Task 2.
3. **JSON do catálogo e do relatório**: nenhuma chave `expectedFacts`/`forbidden`/`reference`/`alternatives` em lugar nenhum (busca recursiva no corpo). → Task 2.
4. **Mesmo id repetido / categoria inválida** no catálogo → 422 com as categorias válidas. → Task 2.
5. **Paridade**: para respostas de exemplo, o resultado TS é igual ao do Python. → Task 1.

---

### Task 1: Contratos, dataset e motor de correção

**Files:**
- Create: `packages/shared/src/evaluation.ts` (+spec, export no `index.ts`), `apps/api/src/modules/evaluation/{dataset.ts,grading.ts,grading.spec.ts,dataset.spec.ts}`

**Interfaces:**
- Produces: `EvalCategorySchema`, `EvalCaseViewSchema`, `EvalSubmitSchema`, `EvalCaseResultSchema`, `EvalReportSchema` (shared); `EVAL_DATASET: readonly EvalCase[]`; `normalize(text: string): string`; `gradeCase(c: EvalCase, answer: string): EvalCaseResult`; `catalog(category?: EvalCategory): EvalCaseView[]`; `evaluate(answers: Record<string, string>): Omit<EvalReport, "usage">` (lança `ValidationError` com os ids desconhecidos).

- [ ] **Step 1: Write the failing tests** — os 13 testes de `test_eval.py` traduzidos (nomes em português equivalentes) + "paridade com o Python" (tabela de respostas de exemplo → resultado esperado; gerar rodando o Python se `python3` com `pydantic` estiver disponível, senão calculada à mão para 5 casos) + "NFD e vírgula decimal casam a alternativa".
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (dataset gerado a partir do Python por script, revisado; `inspectText` do Watchtower existente).
- [ ] **Step 4: Run** `pnpm test`, `pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(evaluation): dataset SEAL BR e correção determinística`

### Task 2: Rotas, escopo, cobrança e documentação

**Files:**
- Create: `apps/api/src/modules/evaluation/{evaluation.controller.ts,evaluation.module.ts}`, `apps/api/test/evaluation/evaluation.e2e.spec.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/modules/tenancy/scopes.decorator.ts`, `apps/api/src/seed/seed.ts` (+`test/seed/seed.int.spec.ts`), `apps/api/test/setup/app.ts`, `apps/api/test/routes/route-scopes.e2e.spec.ts`, `README.md`, `docs/ARCHITECTURE.md`, `docs/DECISOES-E-GARANTIAS.md`

**Interfaces:**
- Consumes: Task 1.
- Produces: `GET /api/eval/cases?category=` e `POST /api/eval/submit` com `@RequireScopes("eval:run")`, padrão de cota/limite/cobrança de `market.controller.ts`.

- [ ] **Step 1: Write the failing tests**: e2e "sem eval:run → 403"; "catálogo traz 42 casos sem gabarito (busca recursiva por chaves proibidas)"; "categoria inválida → 422"; "submit corrige, agrega e cobra uma vez (usage evaluation 5.00)"; "caso inexistente → 422 sem cobrança"; "43 respostas ou resposta > 20 000 → 422 sem cobrança"; "nenhum log contém o texto das respostas"; seed int "chave de demo tem eval:run".
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** + docs (rotas, escopo, decisão de porte determinístico, limitações: sem LLM-judge, sem histórico salvo, dataset estático).
- [ ] **Step 4: Run** `pnpm test`, `test:int`, `test:e2e` (dois locales), `npx prettier --check` e checador de links nos docs → PASS.
- [ ] **Step 5: Commit** `feat(evaluation): rotas do benchmark SEAL BR com escopo eval:run e cobrança`
