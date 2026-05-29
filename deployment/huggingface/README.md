---
title: CARINA Wealth AI
emoji: 💼
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# CARINA Wealth AI — Hugging Face Space

Space Docker que sobe a API (FastAPI + WebSocket) e a UI (Gradio em `/ui`).

## Segredos do Space (Settings → Variables and secrets)

Configure como **Secrets** (nunca como variáveis públicas):

- `NVIDIA_API_KEY`, `NVIDIA_BASE_URL`
- `GROQ_API_KEY`, `GROQ_BASE_URL`
- `FALKORDB_HOST`, `FALKORDB_PORT`, `FALKORDB_USERNAME`, `FALKORDB_PASSWORD`

## Endpoints

- UI: `/ui`
- REST: `/api/...` (`/api/health`, `/api/chat`, `/api/clients/{id}/inbox`, `/api/inbox/{rid}/decision`)
- WebSocket: `/ws/chat`
- Docs: `/docs`

Ver [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md).
