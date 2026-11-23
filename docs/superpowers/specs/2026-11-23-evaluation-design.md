# Design: evaluation (benchmark SEAL BR)

Data: 2026-11-23. Origem: roadmap da Fase 2 e `legacy/python/carina/data_engine/{evaluation,eval_dataset}.py`
(com `tests/test_eval.py` e as rotas `/eval/*` em `carina/api/routes.py`). O usuário delegou a
escolha ("escolha"); o que não está no Python é decisão nossa e está marcado.

## 1. Intenção

Vender a "Agent Evaluation Layer" de `docs/B2B.md`: um tenant B2B lista as perguntas do benchmark
financeiro brasileiro, roda no agente DELE e submete as respostas; o CARINA corrige de forma
determinística (fatos esperados, afirmações proibidas) e passa o Watchtower em cada resposta. O
relatório mede correção factual e postura regulatória. O gabarito nunca sai do servidor.

## 2. Escopo

Entra: os 42 casos portados como estão; o motor de correção; `GET /api/eval/cases` e
`POST /api/eval/submit`; cobrança `evaluation` (R$ 5,00, já na tabela de preços) por submissão.

Fora: LLM-judge, rodar o benchmark contra os agentes do próprio CARINA, histórico de execuções
salvo no banco, tela na web, edição do dataset por API.

Anti-objetivos:
- vazar gabarito (`expectedFacts`, `forbidden`, `reference`) por qualquer rota, erro ou log;
- correção não determinística ou divergente do Python para a mesma resposta;
- cobrar uma submissão recusada (422) ou registrar o texto das respostas em log/auditoria.

## 3. Abordagem

Porte direto, determinístico (escolhida): é o que o produto promete ("reproduzível, auditável e
barata") e o Python já tem gabarito e testes. Alternativas descartadas: LLM-judge (caro, não
reproduzível) e guardar o dataset no banco (sem ganho enquanto não há edição; complica isolamento).

## 4. Desenho

- **Dataset:** `apps/api/src/modules/evaluation/dataset.ts`, os 42 `EvalCase` copiados do Python
  (ids, categoria, dificuldade, pergunta, fatos com alternativas, proibidos, referência) sem mudar o
  conteúdo. Fica SÓ na API (nunca em `packages/shared`, que vai para o bundle da web).
- **Motor:** `grading.ts` puro. `normalize(text)`: minúsculas, `,` → `.`, NFKD sem marcas
  combinantes, espaços colapsados (idêntico ao Python). `gradeCase(case, answer)` → `{ caseId,
  category, score (4 casas), passed, matched, missing, forbiddenHits, complianceFlags }` com
  `complianceFlags = inspectText(answer)` do Watchtower existente. `evaluate(answers)` agrega:
  `answered`, `passed`, `passRate`, `avgScore` (4 casas), `complianceViolations`, `byCategory`,
  `results` em ordem de `caseId`; execução parcial permitida; id inexistente → erro com a lista.
- **Contratos (`packages/shared/src/evaluation.ts`):** `EvalCategorySchema` (`tributacao`, `cvm`,
  `open_finance`, `produtos`, `macro`), `EvalCaseViewSchema` (`id`, `category`, `difficulty`,
  `question` — só isso), `EvalSubmitSchema` (`answers`: record id → texto, 1..42 entradas, texto
  ≤ 20 000 caracteres — limites nossos), `EvalReportSchema` (com `usage`).
- **Rotas:** escopo novo `eval:run` (decisão nossa; o seed dá esse escopo à chave de demo com
  `data:write`, como `market:read`). `GET /api/eval/cases?category=` (categoria inválida → 422,
  sem cobrança). `POST /api/eval/submit` → relatório; cota/limite como as rotas cobradas; cobra
  `evaluation` só depois de corrigir com sucesso, com `clientId` nulo (benchmark é do tenant).
  Respostas e gabarito nunca vão para log nem auditoria (só ids e contagens).

## 5. Testes e aceite

Paridade com `tests/test_eval.py` (mesmos nomes traduzidos): ids únicos e ≥ 42 casos; todas as
categorias; todo caso com fato, alternativa e referência; normalização (acento, vírgula decimal);
resposta correta passa; incompleta lista faltantes; proibida reprova mesmo com fatos; violação de
compliance é flagrada; caso real `acoes-isencao-20k`; catálogo não vaza gabarito; filtro por
categoria; agregação por categoria e execução parcial; caso inexistente falha. Mais: uma tabela de
paridade com respostas de exemplo e o resultado que o Python dá (gerada rodando o Python, se houver
`python3`; senão, calculada à mão para 5 casos). E2E: escopo (403), catálogo sem gabarito no JSON,
submit corrige e cobra uma vez, 422 não cobra, limites do corpo.

## 6. O que fica com quem implementa

Formato exato dos nomes em camelCase, mensagens de erro, e como gerar a tabela de paridade.
