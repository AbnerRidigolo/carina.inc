"""Dependências compartilhadas da API (singletons de processo).

Mantém uma única :class:`InboxService` e :class:`ModelRouter` por processo, e um
cache de :class:`Orchestrator` por ``client_id`` (cada cliente tem seu grafo).
"""

from __future__ import annotations

from functools import lru_cache

from carina.agents.orchestrator import Orchestrator
from carina.inbox.service import InboxService
from carina.models.router import ModelRouter, get_router


@lru_cache
def get_inbox() -> InboxService:
    """Serviço de inbox único do processo."""
    return InboxService()


@lru_cache
def get_orchestrator(client_id: str) -> Orchestrator:
    """Orchestrator (cacheado) para um cliente."""
    router: ModelRouter = get_router()
    return Orchestrator(client_id=client_id, router=router)
