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

## API B2B (Agent API)

A API REST/WS é multi-tenant: toda rota (exceto `/api/health`) exige chave de API
(`Authorization: Bearer sk-...` ou `X-API-Key`), configurada em `CARINA_API_KEYS`.
Cada resolução é medida e precificada por trabalho (`carina/b2b/metering.py`) e
auditada pelo **Watchtower** (`carina/b2b/watchtower.py`) — flags de compliance
(suitability, LGPD/PII, recomendação não autorizada CVM, disclaimers) e trilha
append-only. Endpoints do tenant: `POST /api/chat`, `GET /api/usage`, `GET /api/audit`,
inbox de aprovações. Sem chaves configuradas a API **falha fechada** (tudo 401);
em desenvolvimento, `CARINA_ALLOW_DEV_TENANT=1` habilita um tenant `dev`
implícito (opt-in explícito, nunca em produção).

## Data Engine — Camada 1 (Market Data BR)

Dados de mercado B3 e macro BCB normalizados num schema único
(`carina/data_engine/market_data.py`), em arquitetura de adapter (fontes
atuais: brapi.dev e SGS/BCB; EODHD e B3 direto no futuro), com cache TTL para
proteger rate limits. Endpoints (medidos como `data_query`, R$ 0,05/chamada):
`GET /api/market/quotes?symbols=PETR4,HGLG11`, `GET /api/market/history/{symbol}`
e `GET /api/market/macro` (Selic, CDI, IPCA, PTAX).

## Data Engine — Camada 3 (SEAL BR, avaliação de agentes)

Benchmark de perguntas financeiras brasileiras com correção determinística
(`carina/data_engine/evaluation.py` + dataset curado em `eval_dataset.py`):
tributação (isenção de R$20K, come-cotas, FII, JCP), CVM (suitability,
Resolução 175), Open Finance, produtos e macro. O catálogo nunca expõe o
gabarito; a correção mede fatos esperados, afirmações proibidas E flags de
compliance do Watchtower em cada resposta. Endpoints: `GET /api/eval/cases`
(catálogo) e `POST /api/eval/submit` (execução medida como `evaluation`,
R$ 5,00/execução).

## Builder Layer (estratégias + backtesting)

Esqueleto do Produto 3 (`carina/builder/`): o tenant registra estratégias
**declarativas** validadas (`buy_hold`, `sma_cross` — nunca código arbitrário;
a camada é regulada e auditável por construção) e roda backtests
determinísticos sem lookahead sobre o Market Data BR, com retorno total,
drawdown máximo, volatilidade anualizada e curva de equity. Endpoints:
`POST/GET /api/builder/strategies` e `POST /api/builder/strategies/{id}/backtest`
(medido como `backtest`, R$ 7,50/execução).

Ver [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/AGENTS.md](docs/AGENTS.md),
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) e [docs/B2B.md](docs/B2B.md) (estratégia
e produtos B2B).
