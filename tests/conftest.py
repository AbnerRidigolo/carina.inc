"""Fixtures compartilhadas dos testes do CARINA.

Os testes unitários (``-m "not integration"``) NÃO tocam serviços externos:
o router, o GraphRAG-SDK e o AgentScope são mockados. Os testes ``integration``
exigem credenciais reais no ``.env`` (NIM/Groq/FalkorDB Cloud).
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from carina.config.settings import Settings
from carina.models.router import ModelRouter

_REPO_ROOT = Path(__file__).resolve().parent.parent
_MODELS_YAML = _REPO_ROOT / "carina" / "config" / "models.yaml"


@pytest.fixture
def fake_settings() -> Settings:
    """Settings com credenciais fictícias (suficientes para o router montar env)."""
    return Settings(
        NVIDIA_API_KEY="nvapi-test",
        GROQ_API_KEY="gsk-test",
        FALKORDB_HOST="localhost",
        FALKORDB_PORT=6379,
        FALKORDB_USERNAME="",
        FALKORDB_PASSWORD="",
        CARINA_ENV="test",
    )


@pytest.fixture
def router(fake_settings: Settings) -> ModelRouter:
    """Router carregado do YAML real, com settings de teste."""
    return ModelRouter(settings=fake_settings, config_path=_MODELS_YAML)


def has_live_credentials() -> bool:
    """``True`` quando há credenciais reais para os testes de integração."""
    return bool(os.getenv("NVIDIA_API_KEY") and os.getenv("FALKORDB_HOST"))


requires_live = pytest.mark.skipif(
    not has_live_credentials(),
    reason="credenciais reais ausentes (NVIDIA_API_KEY + FALKORDB_HOST) — defina no .env",
)
