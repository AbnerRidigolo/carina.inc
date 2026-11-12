"""Sobe a API + UI localmente para desenvolvimento.

    python scripts/run_local.py

Carrega ``.env``, configura logging e sobe o FastAPI (com a UI Gradio em /ui) na 8000.
"""

from __future__ import annotations

import uvicorn

if __name__ == "__main__":
    import gradio as gr

    from carina.api.app import app
    from carina.config.settings import get_settings
    from carina.utils.logging import configure_logging
    from frontend.gradio_app import demo

    configure_logging(get_settings().log_level, json_logs=False)
    app = gr.mount_gradio_app(app, demo, path="/ui")
    uvicorn.run(app, host="127.0.0.1", port=8000)
