"""Testes da agentic-inbox: classificação por risco, pausa, decisão e expiração."""

from __future__ import annotations

import pytest

from carina.inbox.models import ApprovalRequest, ApprovalStatus, RiskClass
from carina.inbox.service import InboxService
from carina.utils.errors import InboxError


@pytest.fixture
def service() -> InboxService:
    svc = InboxService()

    async def place_trade(payload: dict) -> dict:
        return {"executed": True, **payload}

    async def save_note(payload: dict) -> dict:
        return {"saved": True, **payload}

    svc.register_executor("place_trade", place_trade)
    svc.register_executor("save_note", save_note)
    return svc


@pytest.mark.asyncio
async def test_read_executes_directly(service: InboxService) -> None:
    service.register_executor("get_balance", lambda p: _aval({"balance": 100}))
    req = ApprovalRequest.create(
        client_id="X", agent="Insight", action="get_balance", risk=RiskClass.READ
    )
    out = await service.submit(req)
    assert out["status"] == "executed"


@pytest.mark.asyncio
async def test_reversible_executes_and_notifies() -> None:
    notified: list[str] = []

    async def notifier(req, result):  # type: ignore[no-untyped-def]
        notified.append(req.action)

    svc = InboxService(notifier=notifier)
    svc.register_executor("save_note", lambda p: _aval({"saved": True}))
    req = ApprovalRequest.create(
        client_id="X", agent="Categorizer", action="save_note", risk=RiskClass.REVERSIBLE
    )
    out = await svc.submit(req)
    assert out["status"] == "executed_and_notified"
    assert notified == ["save_note"]


@pytest.mark.asyncio
async def test_irreversible_pauses_until_approval(service: InboxService) -> None:
    req = ApprovalRequest.create(
        client_id="X",
        agent="Executor",
        action="place_trade",
        risk=RiskClass.IRREVERSIBLE,
        payload={"ticker": "PETR4", "qty": 100},
    )
    out = await service.submit(req)
    assert out["status"] == "pending", "ação irreversível NÃO pode executar sem aprovação"

    pending = await service.list_pending("X")
    assert len(pending) == 1 and pending[0].status is ApprovalStatus.PENDING

    decided = await service.decide(req.id, approved=True, decided_by="user@carina")
    assert decided["status"] == "executed"
    assert decided["result"]["executed"] is True
    assert (await service.list_pending("X")) == []


@pytest.mark.asyncio
async def test_irreversible_rejected_does_not_execute(service: InboxService) -> None:
    req = ApprovalRequest.create(
        client_id="X", agent="Executor", action="place_trade", risk=RiskClass.IRREVERSIBLE
    )
    await service.submit(req)
    out = await service.decide(req.id, approved=False, decided_by="user", reason="risco alto")
    assert out["status"] == "rejected"
    stored = await service._store.get(req.id)
    assert stored.status is ApprovalStatus.REJECTED


@pytest.mark.asyncio
async def test_expired_request_cannot_be_decided(service: InboxService) -> None:
    req = ApprovalRequest.create(
        client_id="X",
        agent="Executor",
        action="place_trade",
        risk=RiskClass.IRREVERSIBLE,
        ttl_seconds=0,  # expira imediatamente
    )
    await service.submit(req)
    with pytest.raises(InboxError):
        await service.decide(req.id, approved=True, decided_by="user")


@pytest.mark.asyncio
async def test_executor_routes_irreversible_to_inbox(router) -> None:
    """O Executor classifica trade como irreversível e o deixa pendente na inbox."""
    from carina.agents.tier2.executor import Executor
    from carina.inbox.models import RiskClass

    svc = InboxService()
    svc.register_executor("place_trade", lambda p: _aval({"executed": True}))
    ex = Executor(client_id="X", inbox=svc, router=router)

    assert ex.classify_risk("place_trade") is RiskClass.IRREVERSIBLE
    assert ex.classify_risk("get_balance") is RiskClass.READ
    assert ex.classify_risk("save_note") is RiskClass.REVERSIBLE

    out = await ex.submit_action("place_trade", {"ticker": "VALE3", "qty": 50})
    assert out["status"] == "pending"
    assert len(await svc.list_pending("X")) == 1


async def _aval(value):  # helper: coroutine que retorna um valor
    return value
