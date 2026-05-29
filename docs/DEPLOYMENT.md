# Deploy — CARINA Wealth AI v3

Deploy 100% gratuito na nuvem. **Zero processamento ou banco no notebook** em produção:
inference, embeddings e banco são serviços gerenciados. **Sem `docker run`** — o banco é
FalkorDB Cloud (connection string).

## 1. FalkorDB Cloud (Free Tier)

1. Crie uma instância free em FalkorDB Cloud.
2. Copie host/port/usuário/senha para o `.env` (`FALKORDB_*`).
3. **Atenção operacional:** a instância free é **parada após 1 dia ociosa** e
   **deletada após 7 dias** ociosos. O **Monitor job** no Modal faz um *keepalive*
   (ping a cada 10 min, ver `modal_jobs/keepalive.py`) → a instância nunca fica ociosa.
   Mantenha o Monitor sempre deployado.

## 2. Modelos (NVIDIA NIM + Groq)

- `NVIDIA_API_KEY` (nvapi-…), free ~40 RPM. `GROQ_API_KEY` para fallback.
- **Modelo é config:** ajuste `carina/config/models.yaml`. Os IDs de modelo NIM são
  placeholders marcados `# TODO confirmar` — **confirme os nomes exatos** na sua conta
  NIM (modelos free podem ser removidos com pouco aviso) e atualize só o YAML.
- Embedder: `nvidia/nv-embedqa-e5-v5` (**1024 dims**). Se trocar o embedder, ajuste
  `dimensions` no YAML (o índice vetorial do FalkorDB depende disso).

## 3. Hugging Face Spaces (API + UI, sempre online)

1. Crie um Space **Docker**. Use `deployment/huggingface/Dockerfile` e `README.md`
   (já com o header do Space, porta 7860).
2. Em *Settings → Variables and secrets*, configure como **Secrets**: `NVIDIA_API_KEY`,
   `NVIDIA_BASE_URL`, `GROQ_API_KEY`, `GROQ_BASE_URL`, `FALKORDB_*`.
3. Endpoints: UI em `/ui`, REST em `/api`, WebSocket em `/ws/chat`, docs em `/docs`.

## 4. Modal (jobs 24/7 — $30/mês grátis)

1. `pip install modal && modal token new`.
2. Crie o secret espelhando o `.env`:
   ```bash
   modal secret create carina-secrets \
       NVIDIA_API_KEY=... GROQ_API_KEY=... \
       FALKORDB_HOST=... FALKORDB_PORT=6379 \
       FALKORDB_USERNAME=... FALKORDB_PASSWORD=...
   ```
3. Deploy:
   ```bash
   modal deploy modal_jobs/monitor_job.py   # vigilância + keepalive (a cada 10 min)
   modal deploy modal_jobs/sync_job.py      # Open Finance → grafo (a cada 6h)
   ```

## Desenvolvimento local (Windows)

`graphrag-sdk` depende de `hnswlib`, que **compila do código-fonte** (não há wheel
pronto no PyPI) e exige **Microsoft C++ Build Tools**. No Windows:

- **Opção A (rodar a stack completa localmente):** instale o
  [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  e então `pip install -e ".[dev]"`.
- **Opção B (sem compilador):** os **testes unitários** rodam sem `graphrag-sdk`
  (`pytest -m "not integration"`); os imports pesados são tardios. O caminho real do
  GraphRAG roda no **Docker do HF Spaces** (o `Dockerfile` já inclui `build-essential`,
  então `hnswlib` compila lá) ou em qualquer host Linux.

## 5. Verificação pós-deploy

- `GET /api/health` → `{"status":"ok"}`.
- `POST /api/chat` com `{"client_id":"demo","message":"..."}` → plano + resultados.
- `python scripts/seed_demo_client.py demo` (com credenciais) → ingest + query com citação.
- Confirme que **nenhum segredo** está no repositório (`.env` no `.gitignore`; só `.env.example`).
