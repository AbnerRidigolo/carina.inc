"""Sync — ETL sem LLM: consolida Open Finance, deduplica e atualiza o grafo (Tier 2).

NÃO usa modelo: é um agente determinístico. Consolida dados de instituições via Open
Finance, deduplica posições/transações e aplica atualizações incrementais ao grafo do
cliente com ``rag.apply_changes`` (sem rebuildar o grafo). ``finalize()`` é chamado UMA
vez ao fim do batch (ver :mod:`carina.knowledge.ingest`).
"""

from __future__ import annotations

from typing import Any

from carina.knowledge.graph import CarinaKnowledge
from carina.knowledge.ingest import Document, apply_changes
from carina.utils.logging import get_logger

_log = get_logger("Sync")


def deduplicate(records: list[dict[str, Any]], *, key: str = "id") -> list[dict[str, Any]]:
    """Remove duplicatas por chave, preservando a ordem (último vence).

    Args:
        records: Registros consolidados de múltiplas instituições.
        key: Campo identificador único.

    Returns:
        Lista deduplicada.
    """
    seen: dict[Any, dict[str, Any]] = {}
    for rec in records:
        seen[rec.get(key)] = rec
    return list(seen.values())


class Sync:
    """Agente de consolidação/atualização do grafo (sem LLM).

    Args:
        client_id: Cliente cujo grafo será atualizado.
        knowledge: Camada de conhecimento. Default: nova :class:`CarinaKnowledge`.
    """

    def __init__(self, client_id: str, knowledge: CarinaKnowledge | None = None) -> None:
        self.client_id = client_id
        self._knowledge = knowledge or CarinaKnowledge()
        self._log = _log.bind(client_id=client_id)

    async def consolidate_and_apply(
        self,
        *,
        added: list[Document] | None = None,
        modified: list[Document] | None = None,
        deleted: list[str] | None = None,
    ) -> None:
        """Aplica um batch de mudanças consolidadas ao grafo (1 finalize ao fim).

        Args:
            added: Documentos novos (ex.: novas posições/transações).
            modified: Documentos alterados.
            deleted: IDs removidos.
        """
        self._log.info(
            "sync.apply",
            added=len(added or []),
            modified=len(modified or []),
            deleted=len(deleted or []),
        )
        await apply_changes(
            self._knowledge,
            self.client_id,
            added=added,
            modified=modified,
            deleted=deleted,
            finalize=True,
        )
