# Design: agentes restantes (Fase 2, entrega 1)

Data: 2026-11-19. Origem: roadmap da Fase 2 (spec `2026-11-11-migracao-typescript-design.md` §3 e
§10) e o código Python em `legacy/python/carina/agents/`. O usuário delegou as escolhas ("pode
começar, escolha você"); tudo abaixo que não está no spec original é decisão nossa e está marcado
como tal.

## 1. Intenção

Fechar a lista de agentes do spec (12 agentes) no núcleo TypeScript, para que o chat cubra
planejamento de longo prazo, tributação, pesquisa na base de conhecimento e a relação com o assessor
humano, e para que as transações importadas ou ingeridas cheguem categorizadas (o que melhora o
Insight e os documentos do Sync, que hoje agrupam tudo em "sem categoria").

## 2. O que entra e o que fica para depois

| Agente | No Python | Nesta entrega | Motivo |
|---|---|---|---|
| strategist | só prompt (reasoning) | especialista do chat, saída estruturada `StrategyPlan` | encaixa no grafo como insight/predictor/risk |
| tax | prompt + `TaxAdvice` (reasoning) | especialista do chat, saída estruturada `TaxAdvice` | idem |
| researcher | prompt + `ingest_findings` | especialista do chat, **só sobre a base de conhecimento**, texto com fontes | não há ferramenta de busca web (nem havia no Python); não grava na base (ver §5) |
| assessor_liaison | prompt + `ingest_assessor_knowledge` | especialista do chat que **redige** perguntas ao assessor, saída `AssessorBrief` | os canais (WhatsApp/e-mail) são da Fase 3; nada é enviado |
| categorizer | regras + LLM no ambíguo | **regras determinísticas** na gravação de transações, sem LLM | sem custo por transação, idempotente, testável |
| monitor | prompt, job no Modal | **fora** (entrega 2) | precisa de um canal de alerta, que não existe |

Não-objetivos: busca web, envio de mensagens ao assessor, gravação na base de conhecimento a partir
do chat, monitor, recategorização manual pela interface, LLM no categorizer.

Anti-objetivos (falha mesmo que "funcione"):
- um agente afirmar número (IR, patrimônio, probabilidade) sem base na base de conhecimento ou sem
  marcar como estimativa;
- o researcher se apresentar como tendo pesquisado na web;
- o assessor_liaison incluir dado do cliente além do necessário à pergunta;
- o categorizer sobrescrever uma categoria que veio do cliente/arquivo;
- a pergunta comum passar a acionar muito mais modelos (custo) do que hoje.

## 3. Abordagem

Consideradas:
1. **Todos como especialistas `LlmAgent` no grafo existente** (escolhida para os quatro de chat):
   mesmo caminho de prompt, sanitização, schema Zod + `refine`, fallback de provedor, mock, eventos
   `agent_result`, cartões na web e cobrança que já existem.
2. Ferramentas (tool calling) para researcher/assessor gravarem na base: descartada nesta entrega;
   escrita disparada por modelo a partir de conteúdo não confiável é um vetor de envenenamento da
   base, e o valor não justifica o risco agora.
3. Categorizer como agente LLM no chat: descartado; categorizar é transformação de dado, não
   conversa, e no chat não melhora as transações gravadas.

## 4. Chat: quatro especialistas novos

### 4.1 Tipos (`packages/shared/src/agents.ts`)

- `SpecialistNameSchema`: `insight`, `predictor`, `risk`, `strategist`, `tax`, `researcher`,
  `assessor_liaison` (nesta ordem, que é a ordem do plano).
- `AgentNameSchema`: os acima mais `navigator` e `executor`.
- Schemas novos (decisão nossa; campos em inglês como os existentes, textos limitados em `refine`):
  - `StrategyPlanSchema`: `targetAllocation` (lista de `{assetClass, pct}`; soma 100 ± 0,5 em
    `refine`), `milestones` (lista de `{goal, byYear, successProbability 0..1}`), `assumptions`
    (lista), `narrative`.
  - `TaxAdviceSchema`: `estimatedTaxBrl` (Money, ≥ 0), `harvestingOpportunities` (lista),
    `offshoreVsBr` (texto), `actions` (lista), `consultAccountant` (boolean), `narrative`.
  - `AssessorBriefSchema`: `questions` (1..5 textos), `sharedData` (lista do que cada pergunta
    revela do cliente), `narrative`.
  - researcher devolve texto (como o navigator), sem schema.

### 4.2 Agentes (`apps/api/src/modules/agents/`)

Um arquivo por agente (`strategist.ts`, `tax.ts`, `researcher.ts`, `assessor-liaison.ts`) no molde
de `risk.ts`; prompts portados do Python em `prompts.ts`, com as mudanças:
- "grafo" → "base de conhecimento do cliente"; sem Modal, FalkorDB, Hermes ou `<think>`;
- researcher: "você NÃO tem acesso à web; responda só com a base de conhecimento, cite cada fonte
  pelo título, marque confiança e data; se a base não tiver a resposta, diga isso";
- assessor_liaison: "você só redige; nada é enviado; liste em `sharedData` o que cada pergunta revela";
- tax e strategist: estimativa explícita, recomendação de consultar contador/planejador quando
  couber, nunca executam (propostas vão ao Executor);
- toda REGRA termina com o aviso de conteúdo não confiável (`withNotice`).
Papéis: strategist e tax `reasoning`; researcher e assessor_liaison `conversational`.
`refine` em `output-limits.ts`: limites de tamanho de listas e textos (como `refineRisk`), soma da
alocação, probabilidades em 0..1, IR ≥ 0.
`AgentRegistry` registra os quatro. O prompt do Navigator passa a citar todos os especialistas.

### 4.3 Classificação

- `heuristic.ts`: palavras-chave novas (decisão nossa; minúsculas, substring, NFC):
  - strategist: `longo prazo`, `aposentadoria`, `objetivo`, `meta`, `planejamento`, `alocação alvo`,
    `sucessão`;
  - tax: `imposto`, `ir `, `tribut`, `darf`, `come-cotas`, `isenção`, `prejuízo a compensar`,
    `offshore`;
  - researcher: `pesquis`, `o que diz`, `fonte`, `verifique`, `fact`, `notícia`;
  - assessor_liaison: `assessor`, `gerente do banco`, `perguntar ao`, `pergunte ao`.
  Revisar colisões com as listas atuais nos testes (ex.: "meta" dentro de outra palavra; usar
  limites de palavra onde a substring pegar demais).
- `CLASSIFIER_PROMPT` lista os sete especialistas com uma linha sobre cada.
- **Limite de custo:** no máximo 3 especialistas por turno (`MAX_SPECIALISTS = 3`), na ordem do
  plano, tanto na heurística quanto em `normalizePlan`. Hoje o máximo já é 3, então o pior caso de
  custo por turno não muda. A complexidade continua calculada pelo número de agentes.

### 4.4 Orquestrador, eventos, cobrança e web

- `orchestrator.service.ts`: o filtro do `agent_result` do nó `specialist` passa a aceitar qualquer
  `SpecialistName` (`SpecialistNameSchema.safeParse`), não a lista fixa de três.
- Cobrança: o tipo de trabalho continua sendo decidido por `classifyWork` (`pricing.ts`): um turno
  com `tax` no plano é `optimization` (R$ 30,00), como no Python (a fase 2 exige os mesmos tipos);
  os demais seguem pelo número de agentes. Os novos agentes entram em `usage_record.agents`. Sem
  tipo de trabalho novo.
- Mock (`mock-responders.ts`): responders determinísticos para os quatro, válidos nos schemas, que
  citam o primeiro título de fonte quando houver (o researcher sempre). O mock do classificador
  continua sendo a heurística.
- Web (`AgentCard.tsx`): rótulos (Strategist, Tributário, Pesquisa, Assessor) e renderização de
  `StrategyPlan` (tabela de alocação + marcos), `TaxAdvice` (IR estimado em R$, oportunidades,
  ações, aviso de contador quando `consultAccountant`) e `AssessorBrief` (perguntas numeradas e o
  que cada uma revela, com o aviso "rascunho, nada foi enviado"). Resultado fora do schema cai no
  render de texto/JSON que já existe.

## 5. Categorizer

- Módulo puro `apps/api/src/modules/data-ingestion/categorize.ts`: `categorize(description, kind)`
  → `string | null`. Regras portadas do Python (investimento, moradia, alimentação, transporte,
  saúde, lazer), com correções:
  - comparação em minúsculas NFC sem acento dos dois lados;
  - palavras curtas (`99`, `xp`, `b3`, `luz`) só com limite de palavra, para não casar dentro de
    outras;
  - `kind` de investimento (`buy`, `sell`, `dividend`) → `investimento`; `tax` → `impostos`;
    `fee` → `tarifas` (categorias novas, decisão nossa);
  - sem casamento → `null` (nada de "outros" inventado; o Sync já mostra "sem categoria").
- Detecção de parcela (`N/M`) fica fora: não há coluna para ela, e criar uma é mudança de schema sem
  consumidor.
- Onde roda: em `IngestionService.upsertTransactionsFor`, antes de gravar, só para itens com
  `category` ausente/nula. Cobre a API de ingestão, a importação de arquivos e o seed.
  **Nunca sobrescreve** categoria enviada no mesmo item. Um reenvio posterior da mesma transação
  grava o que vier nele (o upsert já funciona assim); isso fica documentado como limitação.
- Determinístico e idempotente: reenviar o mesmo lote produz as mesmas categorias.

## 6. Testes e aceite

- Unitários: schemas novos (shared); cada agente com o mock (saída válida, `refine` recusando
  alocação que não soma 100, IR negativo, listas grandes); prompts com `withNotice`; heurística com
  as palavras novas, o corte em 3 e as colisões; `normalizePlan` cortando em 3; categorize com
  tabela de casos (acento, limite de palavra, `kind`, sem casamento → null).
- Integração: ingestão grava a categoria inferida e preserva a enviada; importação OFX de uma
  fixture existente sai com categorias.
- E2E (mock): uma pergunta de imposto produz plano com `tax`, `agent_result` válido em
  `TaxAdviceSchema` e síntese; uma pergunta que casa 4+ áreas roda só 3.
- Web: cartões dos três schemas novos e o rótulo do researcher.
- Docs: README (lista de agentes), `ARCHITECTURE.md`, `DECISOES-E-GARANTIAS.md` (decisões desta
  seção 2–5 e limitações: researcher sem web, assessor sem envio, categorizer só por regras,
  monitor pendente).

## 7. O que fica com quem implementa

Textos exatos dos prompts e das palavras-chave (dentro do descrito), limites numéricos de `refine`
(seguindo os de `refineRisk`), layout dos cartões no estilo dos existentes, e a lista final de
palavras do categorizer (portando as do Python com as correções acima).
