"""Metering por resolução — a base do modelo de precificação B2B.

O cliente B2B paga por trabalho realizado, não por assento (``docs/B2B.md``).
Cada chamada atendida vira um :class:`UsageRecord` imutável com o tipo de
trabalho, os agentes envolvidos e o preço em BRL. O resumo agregado alimenta o
endpoint ``GET /api/usage`` e, futuramente, o faturamento.

Tipos de trabalho e preços seguem a tabela do documento B2B:
Query R$1,50 · Analysis R$7,50 · Multi-agent R$15,00 · Optimization R$30,00 ·
Execution R$75,00 (+ fee sobre valor, fora do escopo deste módulo).
"""

from __future__ import annotations

import abc
import asyncio
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

from carina.config.settings import Settings, get_settings
from carina.utils.logging import get_logger

_log = get_logger(__name__)


class WorkType(str, Enum):
    """Tipo de trabalho realizado (unidade de cobrança)."""

    QUERY = "query"
    ANALYSIS = "analysis"
    MULTI_AGENT_ANALYSIS = "multi_agent_analysis"
    OPTIMIZATION = "optimization"
    EXECUTION = "execution"


#: Preço base B2B por resolução, em BRL (tabela de docs/B2B.md).
PRICE_BRL: dict[WorkType, float] = {
    WorkType.QUERY: 1.50,
    WorkType.ANALYSIS: 7.50,
    WorkType.MULTI_AGENT_ANALYSIS: 15.00,
    WorkType.OPTIMIZATION: 30.00,
    WorkType.EXECUTION: 75.00,
}

#: Agentes cuja participação classifica a resolução como otimização.
_OPTIMIZATION_AGENTS = {"tax", "tax_optimizer", "rebalancer"}


def classify_work(agents: list[str]) -> WorkType:
    """Classifica o tipo de trabalho a partir dos agentes acionados no plano.

    Regras (da tabela de precificação): qualquer agente de otimização →
    ``OPTIMIZATION``; nenhum especialista → ``QUERY``; um especialista →
    ``ANALYSIS``; dois ou mais → ``MULTI_AGENT_ANALYSIS``.
    """
    if any(a in _OPTIMIZATION_AGENTS for a in agents):
        return WorkType.OPTIMIZATION
    if not agents:
        return WorkType.QUERY
    if len(agents) == 1:
        return WorkType.ANALYSIS
    return WorkType.MULTI_AGENT_ANALYSIS


class UsageRecord(BaseModel):
    """Registro imutável de uma resolução cobrável."""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    tenant_id: str
    client_id: str
    work_type: WorkType
    agents: list[str] = Field(default_factory=list)
    price_brl: float
    duration_ms: int = 0
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class MeteringStore(abc.ABC):
    """Persistência append-only de registros de uso."""

    @abc.abstractmethod
    async def append(self, record: UsageRecord) -> None:
        """Acrescenta um registro (nunca atualiza)."""

    @abc.abstractmethod
    async def list_for_tenant(self, tenant_id: str, limit: int = 100) -> list[UsageRecord]:
        """Lista os registros mais recentes de um tenant."""


class InMemoryMeteringStore(MeteringStore):
    """Store em memória (dev/testes). NÃO persiste entre processos."""

    def __init__(self) -> None:
        self._records: list[UsageRecord] = []
        self._lock = asyncio.Lock()

    async def append(self, record: UsageRecord) -> None:
        async with self._lock:
            self._records.append(record.model_copy(deep=True))

    async def list_for_tenant(self, tenant_id: str, limit: int = 100) -> list[UsageRecord]:
        async with self._lock:
            matches = [r for r in self._records if r.tenant_id == tenant_id]
            return [r.model_copy(deep=True) for r in matches[-limit:]]


class FalkorDBMeteringStore(MeteringStore):
    """Store persistente num grafo dedicado ``carina_metering`` (append-only).

    Usa ``CREATE`` (nunca ``MERGE``/``SET``) — registros de uso são imutáveis
    por construção, como exige o faturamento.
    """

    def __init__(self, settings: Settings | None = None, graph_name: str = "carina_metering"):
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

    async def append(self, record: UsageRecord) -> None:
        payload = record.model_dump_json()

        def _write() -> None:
            graph = self._ensure_graph()
            graph.query(
                "CREATE (:Usage {id: $id, tenant_id: $tid, created_at: $ts, json: $json})",
                {
                    "id": record.id,
                    "tid": record.tenant_id,
                    "ts": record.created_at.isoformat(),
                    "json": payload,
                },
            )

        await asyncio.to_thread(_write)

    async def list_for_tenant(self, tenant_id: str, limit: int = 100) -> list[UsageRecord]:
        def _read() -> list[str]:
            graph = self._ensure_graph()
            res = graph.query(
                "MATCH (u:Usage {tenant_id: $tid}) RETURN u.json "
                "ORDER BY u.created_at DESC LIMIT $limit",
                {"tid": tenant_id, "limit": limit},
            )
            return [row[0] for row in res.result_set]

        rows = await asyncio.to_thread(_read)
        return [UsageRecord.model_validate_json(r) for r in rows]


class MeteringService:
    """Registra resoluções cobráveis e agrega o uso por tenant.

    Args:
        store: Persistência dos registros. Default: :class:`InMemoryMeteringStore`.
    """

    def __init__(self, store: MeteringStore | None = None) -> None:
        self._store = store or InMemoryMeteringStore()

    async def record_resolution(
        self,
        *,
        tenant_id: str,
        client_id: str,
        agents: list[str],
        duration_ms: int = 0,
        work_type: WorkType | None = None,
    ) -> UsageRecord:
        """Registra uma resolução e retorna o registro com o preço aplicado.

        Args:
            tenant_id: Tenant cobrado.
            client_id: Cliente final (id efetivo, já com namespace do tenant).
            agents: Agentes acionados no plano (vazio = query simples).
            duration_ms: Duração da resolução.
            work_type: Força o tipo (ex.: ``EXECUTION``); default: classificado
                a partir de ``agents``.
        """
        wt = work_type or classify_work(agents)
        record = UsageRecord(
            tenant_id=tenant_id,
            client_id=client_id,
            work_type=wt,
            agents=agents,
            price_brl=PRICE_BRL[wt],
            duration_ms=duration_ms,
        )
        await self._store.append(record)
        _log.info(
            "metering.recorded",
            tenant_id=tenant_id,
            work_type=wt.value,
            price_brl=record.price_brl,
        )
        return record

    async def summary(self, tenant_id: str, limit: int = 1000) -> dict:
        """Resumo agregado do uso de um tenant (contagem e total por tipo)."""
        records = await self._store.list_for_tenant(tenant_id, limit=limit)
        by_type: dict[str, dict[str, float]] = {}
        total = 0.0
        for r in records:
            bucket = by_type.setdefault(r.work_type.value, {"count": 0, "total_brl": 0.0})
            bucket["count"] += 1
            bucket["total_brl"] = round(bucket["total_brl"] + r.price_brl, 2)
            total = round(total + r.price_brl, 2)
        return {
            "tenant_id": tenant_id,
            "resolutions": len(records),
            "total_brl": total,
            "by_work_type": by_type,
        }
