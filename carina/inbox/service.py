"""Serviço da agentic-inbox — orquestra aprovação humana por classe de risco.

Fluxo assíncrono (NÃO bloqueia o event loop):
  * ``READ``        → executa direto.
  * ``REVERSIBLE``  → executa e notifica.
  * ``IRREVERSIBLE``→ publica como ``pending`` e PAUSA *aquela* ação; o agente segue
                      outras tarefas. A execução real só ocorre em :meth:`decide`
                      (aprovação humana).

Execução é re-despachada por *nome de ação* (registry), não por callable preso à
memória — isso permite aprovar em outro processo (UI/API) sem perder o handler.
"""

from __future__ import annotations

from datetime import timezone, datetime
from typing import Awaitable, Callable

from carina.inbox.models import ApprovalRequest, ApprovalStatus, RiskClass
from carina.inbox.store import InboxStore, InMemoryInboxStore
from carina.utils.errors import InboxError
from carina.utils.logging import get_logger

_log = get_logger(__name__)

#: Executor de uma ação: recebe o payload e retorna o resultado.
Executor = Callable[[dict], Awaitable[object]]
#: Notificador de ações reversíveis já executadas.
Notifier = Callable[[ApprovalRequest, object], Awaitable[None]]


class InboxService:
    """Coordena submissão e decisão de ações classificadas por risco.

    Args:
        store: Persistência das solicitações. Default: :class:`InMemoryInboxStore`.
        notifier: Callback opcional para notificar ações reversíveis executadas.
    """

    def __init__(self, store: InboxStore | None = None, notifier: Notifier | None = None) -> None:
        self._store = store or InMemoryInboxStore()
        self._notifier = notifier
        self._executors: dict[str, Executor] = {}

    def register_executor(self, action: str, executor: Executor) -> None:
        """Registra o handler que executa uma ação quando autorizada.

        Args:
            action: Nome da ação (deve casar com ``ApprovalRequest.action``).
            executor: Coroutine ``async (payload) -> resultado``.
        """
        self._executors[action] = executor

    async def submit(self, request: ApprovalRequest) -> dict:
        """Submete uma ação; executa ou enfileira conforme o risco.

        Returns:
            Dict com ``status`` e, se executada, ``result``; se pendente, ``request_id``.

        Raises:
            InboxError: Se não houver executor registrado para uma ação não-READ.
        """
        log = _log.bind(client_id=request.client_id, agent=request.agent, action=request.action)

        if request.risk is RiskClass.READ:
            log.info("inbox.read_execute")
            result = await self._run(request)
            return {"status": "executed", "result": result}

        if request.risk is RiskClass.REVERSIBLE:
            log.info("inbox.reversible_execute")
            result = await self._run(request)
            if self._notifier is not None:
                await self._notifier(request, result)
            return {"status": "executed_and_notified", "result": result}

        # IRREVERSIBLE → pausa para aprovação humana.
        await self._store.save(request)
        log.info("inbox.pending", request_id=request.id, expires_at=str(request.expires_at))
        return {"status": "pending", "request_id": request.id}

    async def decide(
        self,
        request_id: str,
        *,
        approved: bool,
        decided_by: str,
        reason: str | None = None,
    ) -> dict:
        """Aplica a decisão humana sobre uma solicitação pendente.

        Em aprovação, executa a ação (re-despacho pelo nome). Em rejeição, marca e
        não executa.

        Raises:
            InboxError: Se a solicitação não existir, já tiver sido decidida ou expirado.
        """
        request = await self._store.get(request_id)
        if request is None:
            raise InboxError(f"Solicitação {request_id} não encontrada")
        if request.is_expired:
            request.status = ApprovalStatus.EXPIRED
            await self._store.save(request)
            raise InboxError(f"Solicitação {request_id} expirada")
        if request.status is not ApprovalStatus.PENDING:
            raise InboxError(f"Solicitação {request_id} já decidida ({request.status.value})")

        request.decided_by = decided_by
        request.decided_at = datetime.now(timezone.utc)
        request.reason = reason

        if not approved:
            request.status = ApprovalStatus.REJECTED
            await self._store.save(request)
            _log.info("inbox.rejected", request_id=request_id, by=decided_by)
            return {"status": "rejected", "request_id": request_id}

        request.status = ApprovalStatus.APPROVED
        await self._store.save(request)
        _log.info("inbox.approved", request_id=request_id, by=decided_by)
        result = await self._run(request)
        return {"status": "executed", "request_id": request_id, "result": result}

    async def list_pending(self, client_id: str) -> list[ApprovalRequest]:
        """Lista solicitações pendentes (não expiradas) de um cliente."""
        return await self._store.list_pending(client_id)

    async def get(self, request_id: str) -> ApprovalRequest | None:
        """Retorna uma solicitação pelo id (ou ``None``)."""
        return await self._store.get(request_id)

    async def _run(self, request: ApprovalRequest) -> object:
        """Executa a ação via executor registrado."""
        executor = self._executors.get(request.action)
        if executor is None:
            raise InboxError(f"Sem executor registrado para a ação '{request.action}'")
        return await executor(request.payload)
