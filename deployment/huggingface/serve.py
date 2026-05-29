"""Entrypoint do HF Space: FastAPI (REST + WebSocket) com a UI Gradio montada em /ui.

Porta 7860 (padrão do HF Spaces).
"""

from __future__ import annotations

import gradio as gr
import uvicorn

from carina.api.app import app
from frontend.gradio_app import demo

# Monta a UI Gradio sob /ui, preservando as rotas /api e /ws do FastAPI.
app = gr.mount_gradio_app(app, demo, path="/ui")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=7860)
