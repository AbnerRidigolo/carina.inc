"""Watchtower — observabilidade e compliance em tempo real (``docs/B2B.md``).

Para cada interação de agente, o Watchtower:
  1. Inspeciona o texto de resposta com checagens de compliance determinísticas
     (suitability, PII/LGPD, recomendação não autorizada, disclaimers).
  2. Grava um :class:`AuditEvent` numa trilha **append-only** — quem perguntou,
     quais agentes responderam, flags levantadas, duração e timestamp.

A trilha guarda um *digest* SHA-256 da resposta (não o texto integral) para
permitir verificação de integridade sem duplicar PII do cliente final no log
de auditoria. As flags carregam apenas o trecho mínimo que as disparou.
"""

from __future__ import annotations

import abc
import asyncio
import hashlib
import re
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

from carina.config.settings import Settings, get_settings
from carina.utils.logging import get_logger

_log = get_logger(__name__)


class Severity(str, Enum):
    """Gravidade de uma flag de compliance."""

    INFO = "info"
    WARNING = "warning"
    VIOLATION = "violation"


class ComplianceFlag(BaseModel):
    """Achado de compliance em uma resposta de agente."""

    code: str
    severity: Severity
    detail: str = ""


# ── Checagens determinísticas ────────────────────────────────────────────────

#: Afirmações de certeza em projeções financeiras (violação de suitability).
_CERTAINTY_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"retorno garantido",
        r"lucro garantido",
        r"ganho (?:certo|garantido)",
        r"com certeza vai (?:subir|cair|valorizar|render)",
        r"vai subir com certeza",
        r"sem (?:nenhum )?risco",
        r"risco zero",
    )
]

#: Recomendação direta de compra/venda (conflito com regulação CVM de consultores).
_RECOMMENDATION_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\brecomendo (?:que você )?(?:comprar|vender|compre|venda)\b",
        r"\bvocê deve (?:comprar|vender)\b",
        r"\bcompre (?:agora|já|imediatamente)\b",
        r"\bvenda (?:agora|já|imediatamente)\b",
    )
]

#: PII estruturada que nunca deve aparecer em resposta (LGPD).
_PII_PATTERNS = {
    "cpf": re.compile(r"\b\d{3}\.\d{3}\.\d{3}-\d{2}\b"),
    "email": re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b"),
}

#: Termos que exigem disclaimer quando presentes na resposta.
_DISCLAIMER_TRIGGERS = re.compile(
    r"projeç|cenário|previs|imposto|tributá|fluxo de caixa", re.IGNORECASE
)
_DISCLAIMER_MARKERS = re.compile(
    r"não (?:é|constitui) (?:uma )?recomendaç|estimativa|premissas|"
    r"consulte (?:um|seu) (?:assessor|contador|especialista)|resultados passados",
    re.IGNORECASE,
)


def inspect_text(text: str) -> list[ComplianceFlag]:
    """Roda todas as checagens de compliance sobre um texto de resposta.

    Returns:
        Lista de flags (vazia quando o texto está limpo).
    """
    flags: list[ComplianceFlag] = []

    for pattern in _CERTAINTY_PATTERNS:
        m = pattern.search(text)
        if m:
            flags.append(
                ComplianceFlag(
                    code="suitability.certainty_claim",
                    severity=Severity.VIOLATION,
                    detail=m.group(0),
                )
            )
            break

    for pattern in _RECOMMENDATION_PATTERNS:
        m = pattern.search(text)
        if m:
            flags.append(
                ComplianceFlag(
                    code="cvm.unauthorized_recommendation",
                    severity=Severity.VIOLATION,
                    detail=m.group(0),
                )
            )
            break

    for kind, pattern in _PII_PATTERNS.items():
        if pattern.search(text):
            # Nunca incluir o valor da PII na flag — apenas o tipo detectado.
            flags.append(
                ComplianceFlag(
                    code=f"lgpd.pii_leak.{kind}",
                    severity=Severity.VIOLATION,
                    detail=f"padrão de {kind} detectado na resposta",
                )
            )

    if _DISCLAIMER_TRIGGERS.search(text) and not _DISCLAIMER_MARKERS.search(text):
        flags.append(
            ComplianceFlag(
                code="suitability.missing_disclaimer",
                severity=Severity.WARNING,
                detail="resposta com projeção/tributação sem disclaimer",
            )
        )

    return flags


# ── Trilha de auditoria ──────────────────────────────────────────────────────


class AuditEvent(BaseModel):
    """Evento imutável da trilha de auditoria (uma interação de agente)."""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    tenant_id: str
    client_id: str
    channel: str = "rest"
    query: str
    agents: list[str] = Field(default_factory=list)
    response_digest: str = ""
    flags: list[ComplianceFlag] = Field(default_factory=list)
    duration_ms: int = 0
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class AuditStore(abc.ABC):
    """Persistência append-only da trilha de auditoria."""

    @abc.abstractmethod
    async def append(self, event: AuditEvent) -> None:
        """Acrescenta um evento (nunca atualiza)."""

    @abc.abstractmethod
    async def list_for_tenant(self, tenant_id: str, limit: int = 100) -> list[AuditEvent]:
        """Lista os eventos mais recentes de um tenant."""


class InMemoryAuditStore(AuditStore):
    """Store em memória (dev/testes). NÃO persiste entre processos."""

    def __init__(self) -> None:
        self._events: list[AuditEvent] = []
        self._lock = asyncio.Lock()

    async def append(self, event: AuditEvent) -> None:
        async with self._lock:
            self._events.append(event.model_copy(deep=True))

    async def list_for_tenant(self, tenant_id: str, limit: int = 100) -> list[AuditEvent]:
        async with self._lock:
            matches = [e for e in self._events if e.tenant_id == tenant_id]
            return [e.model_copy(deep=True) for e in matches[-limit:]]


class FalkorDBAuditStore(AuditStore):
    """Store persistente num grafo dedicado ``carina_audit`` (append-only).

    Usa ``CREATE`` (nunca ``MERGE``/``SET``) — a trilha é imutável por
    construção, como exige a auditoria regulatória.
    """

    def __init__(self, settings: Settings | None = None, graph_name: str = "carina_audit"):
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

    async def append(self, event: AuditEvent) -> None:
        payload = event.model_dump_json()

        def _write() -> None:
            graph = self._ensure_graph()
            graph.query(
                "CREATE (:Audit {id: $id, tenant_id: $tid, created_at: $ts, json: $json})",
                {
                    "id": event.id,
                    "tid": event.tenant_id,
                    "ts": event.created_at.isoformat(),
                    "json": payload,
                },
            )

        await asyncio.to_thread(_write)

    async def list_for_tenant(self, tenant_id: str, limit: int = 100) -> list[AuditEvent]:
        def _read() -> list[str]:
            graph = self._ensure_graph()
            res = graph.query(
                "MATCH (a:Audit {tenant_id: $tid}) RETURN a.json "
                "ORDER BY a.created_at DESC LIMIT $limit",
                {"tid": tenant_id, "limit": limit},
            )
            return [row[0] for row in res.result_set]

        rows = await asyncio.to_thread(_read)
        return [AuditEvent.model_validate_json(r) for r in rows]


class Watchtower:
    """Inspeciona respostas e mantém a trilha de auditoria por tenant.

    Args:
        store: Persistência da trilha. Default: :class:`InMemoryAuditStore`.
    """

    def __init__(self, store: AuditStore | None = None) -> None:
        self._store = store or InMemoryAuditStore()

    async def review(
        self,
        *,
        tenant_id: str,
        client_id: str,
        query: str,
        results: dict[str, Any],
        channel: str = "rest",
        duration_ms: int = 0,
    ) -> AuditEvent:
        """Inspeciona os resultados de uma interação e grava o evento de auditoria.

        Args:
            tenant_id: Tenant da interação.
            client_id: Cliente final (id efetivo).
            query: Pergunta original do cliente.
            results: Saída por agente (``Orchestrator.handle()["results"]``).
            channel: Canal de entrada (``rest`` ou ``ws``).
            duration_ms: Duração da resolução.

        Returns:
            O :class:`AuditEvent` gravado (com as flags levantadas).
        """
        flags: list[ComplianceFlag] = []
        serialized = ""
        for agent, output in results.items():
            text = output if isinstance(output, str) else str(output)
            serialized += f"[{agent}]{text}"
            flags.extend(inspect_text(text))

        event = AuditEvent(
            tenant_id=tenant_id,
            client_id=client_id,
            channel=channel,
            query=query,
            agents=list(results.keys()),
            response_digest=hashlib.sha256(serialized.encode("utf-8")).hexdigest(),
            flags=flags,
            duration_ms=duration_ms,
        )
        await self._store.append(event)
        log = _log.bind(tenant_id=tenant_id, audit_id=event.id)
        if flags:
            log.warning("watchtower.flags", codes=[f.code for f in flags])
        else:
            log.info("watchtower.clean")
        return event

    async def trail(self, tenant_id: str, limit: int = 100) -> list[AuditEvent]:
        """Trilha de auditoria recente de um tenant."""
        return await self._store.list_for_tenant(tenant_id, limit=limit)
