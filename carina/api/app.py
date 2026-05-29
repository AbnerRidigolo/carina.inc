"""App FastAPI do CARINA: REST + WebSocket.

Execução local::

    uvicorn carina.api.app:app --reload

Em produção (HF Spaces), o Dockerfile sobe este app + a UI Gradio.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from carina.api import routes, ws
from carina.config.settings import get_settings
from carina.utils.logging import configure_logging, get_logger

_log = get_logger("api.app")


@asynccontextmanager
async def lifespan(app: FastAPI):  # type: ignore[no-untyped-def]
    """Inicializa logging na subida do app."""
    settings = get_settings()
    configure_logging(settings.log_level)
    _log.info("api.startup", env=settings.carina_env)
    yield
    _log.info("api.shutdown")


app = FastAPI(
    title="CARINA Wealth AI",
    version="0.3.0",
    description="Plataforma de gestão patrimonial autônoma multi-agente.",
    lifespan=lifespan,
)
app.include_router(routes.router, prefix="/api")
app.include_router(ws.router)


@app.get("/")
async def root() -> dict:
    """Raiz informativa."""
    return {"service": "carina", "version": "0.3.0", "docs": "/docs"}
