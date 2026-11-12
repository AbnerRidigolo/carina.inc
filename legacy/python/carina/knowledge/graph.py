"""Wrapper fino sobre o GraphRAG-SDK + FalkorDB Cloud.

NÃO reimplementa um GraphRAGManager manual: delega 100% ao GraphRAG-SDK, que já
combina grafo + vetor + full-text num único banco gerenciado, com citação de fonte
embutida (compliance).

Isolamento por cliente = multi-tenancy nativo do SDK:
    graph_name = f"client_{client_id}"   → cada cliente tem um grafo isolado.

Padrão de uso::

    kb = CarinaKnowledge()
    async with kb.open(client_id="abc") as rag:
        await rag.ingest(text=..., document_id="doc1")
        await rag.finalize()                      # 1x por batch (NÃO por arquivo)
        ans = await rag.completion("...", return_context=True)

``finalize()`` é O(tamanho do grafo) → chamar UMA vez ao fim de um batch.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from carina.config.schema import get_carina_schema
from carina.config.settings import Settings, get_settings
from carina.models.roles import Role
from carina.models.router import ModelRouter, get_router
from carina.utils.errors import KnowledgeError
from carina.utils.logging import get_logger

_log = get_logger(__name__)


def graph_name_for(client_id: str) -> str:
    """Nome do grafo isolado de um cliente (multi-tenancy nativo do SDK)."""
    if not client_id or not str(client_id).strip():
        raise KnowledgeError("client_id vazio — isolamento de grafo exige um id válido")
    return f"client_{client_id}"


class CarinaKnowledge:
    """Fachada da camada de conhecimento por cliente.

    Args:
        settings: Configuração (conexão FalkorDB). Default: :func:`get_settings`.
        router: Router de modelos (LLM + embedder). Default: :func:`get_router`.
    """

    def __init__(
        self,
        settings: Settings | None = None,
        router: ModelRouter | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        self._router = router or get_router()

    def _connection(self, client_id: str) -> Any:
        """Monta o ``ConnectionConfig`` do FalkorDB Cloud para o grafo do cliente."""
        from graphrag_sdk import ConnectionConfig

        s = self._settings
        s.require_falkordb()
        return ConnectionConfig(
            host=s.falkordb_host,
            port=s.falkordb_port,
            username=s.falkordb_username or None,
            password=s.falkordb_password or None,
            graph_name=graph_name_for(client_id),
        )

    @asynccontextmanager
    async def open(self, client_id: str) -> AsyncIterator[Any]:
        """Abre o ``GraphRAG`` do cliente como context manager assíncrono.

        O LLM usado internamente pelo SDK é o do papel ``reasoning`` (extração de
        entidades exige aderência a schema); o embedder é o configurado (1024d).

        Args:
            client_id: Identificador do cliente (define o grafo isolado).

        Yields:
            A instância ``GraphRAG`` pronta para ``ingest``/``completion``/etc.
        """
        from graphrag_sdk import GraphRAG

        log = _log.bind(client_id=client_id, graph=graph_name_for(client_id))
        try:
            async with GraphRAG(
                connection=self._connection(client_id),
                llm=self._router.llm_for(Role.REASONING),
                embedder=self._router.embedder(),
                schema=get_carina_schema(),
            ) as rag:
                log.info("knowledge.open")
                yield rag
        except KnowledgeError:
            raise
        except Exception as exc:  # noqa: BLE001 - fronteira: traduzimos p/ erro do domínio
            log.error("knowledge.open_failed", error=str(exc))
            raise KnowledgeError(f"Falha ao abrir grafo de {client_id}: {exc}") from exc
