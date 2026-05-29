"""Modelos Pydantic da agentic-inbox (aprovação humana classificada por risco)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from enum import Enum
from uuid import uuid4

from pydantic import BaseModel, Field


class RiskClass(str, Enum):
    """Classificação de risco que decide o fluxo de aprovação.

    * ``READ``        → leitura/análise: executa direto, sem inbox.
    * ``REVERSIBLE``  → reversível (re-categorizar, salvar nota): executa e notifica.
    * ``IRREVERSIBLE``→ irreversível (trade, transferência, envio externo, qualquer
                        movimento de dinheiro): SEMPRE exige aprovação humana.
    """

    READ = "read"
    REVERSIBLE = "reversible"
    IRREVERSIBLE = "irreversible"


class ApprovalStatus(str, Enum):
    """Estado de uma solicitação de aprovação."""

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ApprovalRequest(BaseModel):
    """Solicitação de aprovação publicada na inbox por um agente.

    Attributes:
        id: Identificador único.
        client_id: Cliente dono da ação.
        agent: Agente que originou a ação.
        action: Nome curto da ação (ex.: ``place_trade``, ``transfer``).
        payload: Parâmetros da ação (validados pelo agente antes de publicar).
        risk: Classe de risco.
        status: Estado atual.
        created_at / expires_at: Janela de validade.
        decided_by / decided_at: Quem e quando decidiu.
        reason: Justificativa da decisão (em rejeição/aprovação).
    """

    id: str = Field(default_factory=lambda: uuid4().hex)
    client_id: str
    agent: str
    action: str
    payload: dict = Field(default_factory=dict)
    risk: RiskClass
    status: ApprovalStatus = ApprovalStatus.PENDING
    created_at: datetime = Field(default_factory=_now)
    expires_at: datetime | None = None
    decided_by: str | None = None
    decided_at: datetime | None = None
    reason: str | None = None

    @classmethod
    def create(
        cls,
        *,
        client_id: str,
        agent: str,
        action: str,
        risk: RiskClass,
        payload: dict | None = None,
        ttl_seconds: int | None = 86_400,
    ) -> "ApprovalRequest":
        """Cria uma solicitação já com janela de expiração.

        Args:
            ttl_seconds: Validade em segundos (default 24h). ``None`` = sem expiração.
        """
        expires = _now() + timedelta(seconds=ttl_seconds) if ttl_seconds is not None else None
        return cls(
            client_id=client_id,
            agent=agent,
            action=action,
            risk=risk,
            payload=payload or {},
            expires_at=expires,
        )

    @property
    def is_expired(self) -> bool:
        """``True`` se passou de ``expires_at`` e ainda está pendente."""
        return (
            self.status is ApprovalStatus.PENDING
            and self.expires_at is not None
            and _now() >= self.expires_at
        )
