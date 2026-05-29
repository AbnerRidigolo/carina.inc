# Arquitetura — CARINA Wealth AI v3

## Visão geral

```
            ┌──────────────┐         ┌──────────────────────────┐
 Cliente ──▶│  API / UI    │──────▶ │  Orchestrator (Zeus)      │
            │ FastAPI+WS   │         │  classifica + coordena    │
            │ Gradio       │         └─────────┬────────────────┘
            └──────────────┘                   │ asyncio.gather (paralelo)
                                   ┌────────────┼────────────────────┐
                                   ▼            ▼                     ▼
                              Tier 1        Tier 2 (inbox)        Tier 3
                              cognitivos    operacionais          analíticos
                                   │            │                     │
                                   └────────────┴─────────┬───────────┘
                                                          ▼
                                          ┌───────────────────────────┐
                                          │  knowledge/ (wrapper fino) │
                                          │  GraphRAG-SDK              │
                                          └─────────────┬─────────────┘
                                                        ▼
                                          ┌───────────────────────────┐
                                          │  FalkorDB Cloud (gerenc.)  │
                                          │  grafo+vetor+full-text     │
                                          │  graph_name=client_<id>    │
                                          └───────────────────────────┘

  Camada de modelos: models/router.py → LiteLLM → NIM (primário) / Hermes (reasoning) / Groq (fallback)
  Jobs 24/7: Modal (Monitor + Sync + keepalive do FalkorDB)
```

## Camadas

### Conhecimento (`carina/knowledge/`)
Wrapper **fino** sobre o GraphRAG-SDK — não há GraphRAGManager manual. Isolamento por
cliente é o multi-tenancy nativo do SDK: `graph_name = f"client_{client_id}"`. O SDK
combina grafo + vetor + full-text num único banco gerenciado, com citação de fonte
embutida (`return_context=True` → trilha de compliance).

Regra operacional: `finalize()` é O(tamanho do grafo) → **uma vez por batch**, nunca por
arquivo. Atualizações incrementais via `apply_changes` (usado pelo Sync).

### Modelos (`carina/models/`)
Roteamento **por papel** (`conversational`/`reasoning`/`embeddings`) definido em
`config/models.yaml`. Trocar provedor/modelo é editar YAML. Fallback automático em
rate-limit/erro (`ModelRouter.acompletion`): NIM → Groq. Embeddings (NeMo Retriever,
1024d) sem fallback → cache agressivo.

### Agentes (`carina/agents/`)
Cada agente herda `CarinaBaseAgent` (sobre o `ReActAgent` do AgentScope), resolve seu
modelo por papel, consulta o grafo do cliente e loga toda ação. System prompt no molde
`# IDENTIDADE → # CONTEXTO → # TAREFA → # REGRA`. Agentes de raciocínio usam saída
estruturada (Pydantic `structured_model`) com Hermes `<think>`.

O **Orchestrator (Zeus)** classifica complexidade (simples/média/complexa) e coordena —
sequencial ou paralelo (`asyncio.gather`, ex.: Insight + Risk).

### Agentic-inbox (`carina/inbox/`)
Aprovação humana classificada por risco:
- `READ` → executa direto.
- `REVERSIBLE` → executa e notifica.
- `IRREVERSIBLE` → publica `pending`, **pausa aquela ação** (sem bloquear o event loop),
  segue outras tarefas; executa só após decisão humana. Re-despacho por nome de ação
  (registry), permitindo aprovar via API/UI em outro processo.

### API / UI / Jobs
FastAPI (`/api`) + WebSocket (`/ws/chat`) + Gradio (`/ui`). Jobs 24/7 no Modal: Monitor
(vigilância + keepalive) e Sync (Open Finance → grafo).

## Princípios
async/await em todo I/O · Pydantic nas fronteiras · try/except + log estruturado ·
sem credencial hardcoded · modelo sempre de config · zero processamento/banco local em produção.
