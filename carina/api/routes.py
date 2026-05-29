"""Rotas REST do CARINA (FastAPI)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from carina.api.deps import get_inbox, get_orchestrator
from carina.utils.errors import InboxError
from carina.utils.logging import get_logger

_log = get_logger("api")
router = APIRouter()


class ChatRequest(BaseModel):
    """Pedido de chat de um cliente."""

    client_id: str = Field(min_length=1)
    message: str = Field(min_length=1)


class DecisionRequest(BaseModel):
    """Decisão humana sobre uma solicitação da inbox."""

    approved: bool
    decided_by: str = Field(min_length=1)
    reason: str | None = None


@router.get("/health")
async def health() -> dict:
    """Liveness simples."""
    return {"status": "ok"}


@router.post("/chat")
async def chat(req: ChatRequest) -> dict:
    """Processa uma mensagem via Orchestrator (multi-agente)."""
    orch = get_orchestrator(req.client_id)
    return await orch.handle(req.message)


@router.get("/clients/{client_id}/inbox")
async def list_inbox(client_id: str) -> dict:
    """Lista as aprovações pendentes de um cliente."""
    pending = await get_inbox().list_pending(client_id)
    return {"pending": [p.model_dump(mode="json") for p in pending]}


@router.post("/inbox/{request_id}/decision")
async def decide(request_id: str, body: DecisionRequest) -> dict:
    """Aplica a decisão humana (aprovar/rejeitar) a uma solicitação."""
    try:
        return await get_inbox().decide(
            request_id,
            approved=body.approved,
            decided_by=body.decided_by,
            reason=body.reason,
        )
    except InboxError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
