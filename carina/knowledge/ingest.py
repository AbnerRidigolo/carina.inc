"""Helpers de ingestão no grafo do cliente (GraphRAG-SDK).

Encapsulam a regra operacional crítica: ``finalize()`` é O(tamanho do grafo) e
deve ser chamado UMA vez ao fim de um batch — nunca por arquivo.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from carina.knowledge.graph import CarinaKnowledge
from carina.utils.errors import KnowledgeError
from carina.utils.logging import get_logger

_log = get_logger(__name__)


@dataclass
class Document:
    """Documento a ingerir no grafo.

    Attributes:
        document_id: Identificador único e estável (idempotência/atualização).
        text: Conteúdo textual já extraído (PDF/HTML → texto antes de chamar).
        metadata: Metadados opcionais (fonte, data, autor) para trilha de citação.
    """

    document_id: str
    text: str
    metadata: dict[str, Any] = field(default_factory=dict)


async def ingest_documents(
    knowledge: CarinaKnowledge,
    client_id: str,
    documents: list[Document],
    *,
    finalize: bool = True,
) -> int:
    """Ingere um batch de documentos no grafo do cliente.

    Args:
        knowledge: Fachada da camada de conhecimento.
        client_id: Cliente alvo (grafo isolado).
        documents: Documentos do batch.
        finalize: Se ``True`` (default), chama ``finalize()`` UMA vez ao fim do
            batch (dedup + backfill de embeddings + índices). Passe ``False`` ao
            encadear múltiplos batches e finalize manualmente ao término.

    Returns:
        Quantidade de documentos ingeridos.

    Raises:
        KnowledgeError: Em falha de ingestão.
    """
    if not documents:
        return 0
    log = _log.bind(client_id=client_id, batch_size=len(documents))
    try:
        async with knowledge.open(client_id) as rag:
            for doc in documents:
                await rag.ingest(text=doc.text, document_id=doc.document_id)
                log.info("knowledge.ingested", document_id=doc.document_id)
            if finalize:
                await rag.finalize()
                log.info("knowledge.finalized")
        return len(documents)
    except KnowledgeError:
        raise
    except Exception as exc:  # noqa: BLE001 - fronteira
        log.error("knowledge.ingest_failed", error=str(exc))
        raise KnowledgeError(f"Falha ao ingerir batch para {client_id}: {exc}") from exc


async def apply_changes(
    knowledge: CarinaKnowledge,
    client_id: str,
    *,
    added: list[Document] | None = None,
    modified: list[Document] | None = None,
    deleted: list[str] | None = None,
    finalize: bool = True,
) -> None:
    """Aplica atualizações incrementais ao grafo (usado pelo Sync Agent).

    Repassa para ``rag.apply_changes`` sem rebuildar o grafo. ``finalize()`` é
    chamado UMA vez ao fim.

    Args:
        knowledge: Fachada da camada de conhecimento.
        client_id: Cliente alvo.
        added: Documentos novos.
        modified: Documentos alterados.
        deleted: IDs de documentos a remover.
        finalize: Finaliza ao fim do batch (default ``True``).
    """
    log = _log.bind(client_id=client_id)
    try:
        async with knowledge.open(client_id) as rag:
            await rag.apply_changes(
                added=[(d.text, d.document_id) for d in (added or [])],
                modified=[(d.text, d.document_id) for d in (modified or [])],
                deleted=list(deleted or []),
            )
            if finalize:
                await rag.finalize()
        log.info(
            "knowledge.applied_changes",
            added=len(added or []),
            modified=len(modified or []),
            deleted=len(deleted or []),
        )
    except Exception as exc:  # noqa: BLE001 - fronteira
        log.error("knowledge.apply_changes_failed", error=str(exc))
        raise KnowledgeError(f"Falha ao aplicar mudanças para {client_id}: {exc}") from exc
