"""Persistência da agentic-inbox.

Define a interface :class:`InboxStore` e duas implementações:
  * :class:`InMemoryInboxStore` — default para dev/testes (sem dependências).
  * :class:`FalkorDBInboxStore` — produção, grafo dedicado no MESMO FalkorDB Cloud.

Operações são assíncronas para não bloquear o event loop. A implementação FalkorDB
executa o I/O síncrono do cliente ``falkordb`` em thread (``asyncio.to_thread``).
"""

from __future__ import annotations

import abc
import asyncio
import json
from typing import Any

from carina.config.settings import Settings, get_settings
from carina.inbox.models import ApprovalRequest, ApprovalStatus
from carina.utils.errors import InboxError
from carina.utils.logging import get_logger

_log = get_logger(__name__)


class InboxStore(abc.ABC):
    """Interface de armazenamento de solicitações de aprovação."""

    @abc.abstractmethod
    async def save(self, request: ApprovalRequest) -> None:
        """Cria ou atualiza uma solicitação."""

    @abc.abstractmethod
    async def get(self, request_id: str) -> ApprovalRequest | None:
        """Retorna uma solicitação pelo id (ou ``None``)."""

    @abc.abstractmethod
    async def list_pending(self, client_id: str) -> list[ApprovalRequest]:
        """Lista as solicitações pendentes (não expiradas) de um cliente."""


class InMemoryInboxStore(InboxStore):
    """Store em memória (dev/testes). NÃO persiste entre processos."""

    def __init__(self) -> None:
        self._data: dict[str, ApprovalRequest] = {}
        self._lock = asyncio.Lock()

    async def save(self, request: ApprovalRequest) -> None:
        async with self._lock:
            self._data[request.id] = request.model_copy(deep=True)

    async def get(self, request_id: str) -> ApprovalRequest | None:
        async with self._lock:
            req = self._data.get(request_id)
            return req.model_copy(deep=True) if req else None

    async def list_pending(self, client_id: str) -> list[ApprovalRequest]:
        async with self._lock:
            return [
                r.model_copy(deep=True)
                for r in self._data.values()
                if r.client_id == client_id
                and r.status is ApprovalStatus.PENDING
                and not r.is_expired
            ]


class FalkorDBInboxStore(InboxStore):
    """Store persistente num grafo dedicado do FalkorDB Cloud.

    Usa um único grafo ``carina_inbox`` com nós ``(:Approval {id, client_id, json})``.
    O conteúdo serializado em JSON evita acoplar o schema da inbox ao do conhecimento.

    Args:
        settings: Configuração (conexão FalkorDB). Default: :func:`get_settings`.
        graph_name: Nome do grafo da inbox. Default ``carina_inbox``.
    """

    def __init__(self, settings: Settings | None = None, graph_name: str = "carina_inbox") -> None:
        self._settings = settings or get_settings()
        self._graph_name = graph_name
        self._graph: Any | None = None

    def _ensure_graph(self) -> Any:
        if self._graph is not None:
            return self._graph
        from falkordb import FalkorDB  # import tardio

        s = self._settings
        s.require_falkordb()
        db = FalkorDB(
            host=s.falkordb_host,
            port=s.falkordb_port,
            username=s.falkordb_username or None,
            password=s.falkordb_password or None,
        )
        self._graph = db.select_graph(self._graph_name)
        return self._graph

    async def save(self, request: ApprovalRequest) -> None:
        payload = request.model_dump_json()

        def _write() -> None:
            graph = self._ensure_graph()
            graph.query(
                "MERGE (a:Approval {id: $id}) "
                "SET a.client_id = $client_id, a.status = $status, a.json = $json",
                {
                    "id": request.id,
                    "client_id": request.client_id,
                    "status": request.status.value,
                    "json": payload,
                },
            )

        try:
            await asyncio.to_thread(_write)
        except Exception as exc:  # noqa: BLE001 - fronteira
            _log.error("inbox.save_failed", request_id=request.id, error=str(exc))
            raise InboxError(f"Falha ao salvar solicitação {request.id}: {exc}") from exc

    async def get(self, request_id: str) -> ApprovalRequest | None:
        def _read() -> str | None:
            graph = self._ensure_graph()
            res = graph.query("MATCH (a:Approval {id: $id}) RETURN a.json", {"id": request_id})
            return res.result_set[0][0] if res.result_set else None

        raw = await asyncio.to_thread(_read)
        return ApprovalRequest.model_validate_json(raw) if raw else None

    async def list_pending(self, client_id: str) -> list[ApprovalRequest]:
        def _read() -> list[str]:
            graph = self._ensure_graph()
            res = graph.query(
                "MATCH (a:Approval {client_id: $cid, status: 'pending'}) RETURN a.json",
                {"cid": client_id},
            )
            return [row[0] for row in res.result_set]

        rows = await asyncio.to_thread(_read)
        out = [ApprovalRequest.model_validate_json(r) for r in rows]
        return [r for r in out if not r.is_expired]
