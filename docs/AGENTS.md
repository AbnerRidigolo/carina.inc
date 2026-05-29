# Os 12 agentes do CARINA

Molde de system prompt (obrigatório): `# IDENTIDADE → # CONTEXTO → # TAREFA → # REGRA`
(regra dura no fim). Cada agente herda `CarinaBaseAgent`, resolve modelo por papel,
consulta o grafo do cliente e loga ações.

## Tier 1 — Cognitive
| # | Agente | Papel | Função |
|---|--------|-------|--------|
| 1 | Navigator | conversational | Interface; classifica intent e roteia. |
| 2 | Strategist | reasoning | Planejamento de longo prazo, Monte Carlo, goal-based. |
| 3 | Researcher | conversational+web | Pesquisa, lê PDFs/notícias, fact-check; ingere no grafo. |
| 4 | Assessor Liaison | conversational | Pergunta ao assessor humano, extrai e ingere conhecimento. |

## Tier 2 — Operational (com agentic-inbox)
| # | Agente | Papel | Função |
|---|--------|-------|--------|
| 5 | Monitor | conversational (Modal) | Vigilância 24/7 preço/volume/notícia; mantém FalkorDB ativo. |
| 6 | Executor | reasoning | Prepara ações; irreversíveis SEMPRE via inbox. |
| 7 | Sync | sem LLM (ETL) | Consolida Open Finance, deduplica, `apply_changes`. |
| 8 | Categorizer | ML leve + LLM fallback | Categoriza transações, detecta recorrência/parcelas. |

## Tier 3 — Analytical
| # | Agente | Papel | Função |
|---|--------|-------|--------|
| 9 | Insight | conversational | Análise de portfólio/gastos, anomalias. |
| 10 | Predictor | reasoning (Hermes `<think>`) | Projeção de fluxo de caixa 12–36m, cenários macro. |
| 11 | Tax Optimizer | reasoning | IR em tempo real, tax loss harvesting, offshore vs BR. |
| 12 | Rebalancer + Risk | reasoning | Drift, VaR, correlação, stress test. |

## Orchestrator (Zeus)
Classifica complexidade (simples/média/complexa) e coordena workflow sequencial ou
paralelo (`asyncio.gather` p/ Insight + Risk juntos). Contingência heurística por
keywords se o modelo de classificação falhar — nunca trava o event loop.

## Saída estruturada
Predictor (`CashFlowForecast`), Rebalancer+Risk (`RiskAssessment`) e Tax Optimizer
(`TaxAdvice`) usam `structured_model` Pydantic → JSON aderente a schema via Hermes.
