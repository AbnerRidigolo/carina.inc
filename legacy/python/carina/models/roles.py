"""Papéis de modelo — abstração que desacopla agentes de provedores concretos.

Um agente pede um modelo por PAPEL (``conversational``, ``reasoning``,
``embeddings``); o :class:`~carina.models.router.ModelRouter` resolve o modelo
concreto + cadeia de fallback a partir de ``models.yaml``.
"""

from __future__ import annotations

from enum import Enum


class Role(str, Enum):
    """Papel funcional de um modelo dentro do CARINA."""

    CONVERSATIONAL = "conversational"
    REASONING = "reasoning"
    EMBEDDINGS = "embeddings"
