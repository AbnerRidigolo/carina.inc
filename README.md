# CARINA Wealth AI v3

Plataforma de gestão patrimonial autônoma para investidores HNWI brasileiros (R$1M–50M),
com **12 agentes especializados** coordenados, **deploy 100% gratuito na nuvem** (zero
processamento ou banco no notebook), camada de modelos flexível com fallback e conhecimento
via **GraphRAG-SDK** sobre **FalkorDB Cloud**.

## Princípios inegociáveis

1. **Nada roda na máquina do dev em produção** — inference, embeddings e banco são serviços na nuvem.
2. **Sem `docker run`** — o banco é FalkorDB Cloud (serviço gerenciado, connection string).
3. **Modelo é config, não código** — roteamento por LiteLLM; trocar provedor = editar YAML.
4. **Toda ação externa irreversível passa por aprovação humana** (agentic-inbox), classificada por risco.
5. `async/await` em todo I/O · Pydantic em toda fronteira · try/except + log estruturado sempre.

## Stack

| Camada            | Tecnologia                                                        |
| ----------------- | ----------------------------------------------------------------- |
| Orquestração      | AgentScope                                                        |
| Conhecimento      | GraphRAG-SDK + FalkorDB Cloud (grafo + vetor + full-text)         |
| Modelos           | LiteLLM → NVIDIA NIM (primário) · Hermes 4 (reasoning) · Groq (fallback) |
| API / UI          | FastAPI + WebSocket · Gradio                                      |
| Jobs 24/7         | Modal                                                            |
| Deploy online     | Hugging Face Spaces                                              |

## Estrutura

```
carina/        agents/ · knowledge/ · models/ · inbox/ · api/ · integrations/ · config/ · utils/
modal_jobs/    jobs 24/7 (Monitor, Sync, keepalive do FalkorDB)
frontend/      UI Gradio
deployment/    huggingface/ · modal/
scripts/ tests/ docs/
```

## Setup

```bash
python -m venv .venv && . .venv/Scripts/activate   # Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -e ".[dev,modal]"
cp .env.example .env        # preencher chaves (NUNCA comitar .env)
pytest -m "not integration" # testes unitários (mockados)
pytest -m integration       # testes live (exigem credenciais reais)
```

A troca de modelos é feita em [carina/config/models.yaml](carina/config/models.yaml) — sem tocar em código.

Ver [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/AGENTS.md](docs/AGENTS.md) e
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
