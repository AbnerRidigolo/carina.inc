# Dockerfile do CARINA para Hugging Face Spaces (API FastAPI + UI Gradio sempre online).
# HF Spaces expõe a porta 7860.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    CARINA_ENV=production

WORKDIR /app

# Dependências de sistema (PDF/loader do GraphRAG, build de wheels).
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Instala o pacote (extras litellm/pdf vêm via dependência graphrag-sdk).
COPY pyproject.toml README.md ./
COPY carina ./carina
COPY frontend ./frontend
RUN pip install --upgrade pip && pip install .

EXPOSE 7860

# Sobe FastAPI (inclui WebSocket) e monta a UI Gradio em /ui via serve.py.
COPY deployment/huggingface/serve.py ./serve.py
CMD ["python", "serve.py"]
