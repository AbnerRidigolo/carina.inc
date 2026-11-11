"""Camada de modelos: roteamento por papel + fallback automático (via LiteLLM)."""

from carina.models.roles import Role
from carina.models.router import ModelRouter, get_router

__all__ = ["Role", "ModelRouter", "get_router"]
