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
    DATA_QUERY = "data_query"
    EVALUATION = "evaluation"


#: Preço base B2B por resolução, em BRL (tabela de docs/B2B.md; DATA_QUERY é
#: a chamada do Data Engine — "SaaS por volume de chamadas" — e EVALUATION é
#: uma execução do benchmark SEAL BR).
PRICE_BRL: dict[WorkType, float] = {
    WorkType.QUERY: 1.50,
    WorkType.ANALYSIS: 7.50,
    WorkType.MULTI_AGENT_ANALYSIS: 15.00,
    WorkType.OPTIMIZATION: 30.00,
    WorkType.EXECUTION: 75.00,
    WorkType.DATA_QUERY: 0.05,
    WorkType.EVALUATION: 5.00,
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


#: Chaves de payload onde o valor movimentado de uma execução pode estar.
_VALUE_KEYS = ("value_brl", "amount", "value", "valor")


def extract_value_brl(payload: dict) -> float:
    """Extrai o valor movimentado (BRL) do payload de uma execução.

    Procura nas chaves convencionais (:data:`_VALUE_KEYS`); retorna ``0.0``
    quando ausente ou não numérico — execução sem valor identificável cobra
    apenas o preço base.
    """
    for key in _VALUE_KEYS:
        raw = payload.get(key)
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            return abs(float(raw))
    return 0.0


class UsageRecord(BaseModel):
    """Registro imutável de uma resolução cobrável.

    Para ``EXECUTION``, ``price_brl`` = preço base + ``fee_brl`` (fee sobre o
    ``value_brl`` movimentado, conforme docs/B2B.md).
    """

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    tenant_id: str
    client_id: str
    work_type: WorkType
    agents: list[str] = Field(default_factory=list)
    price_brl: float
    value_brl: float = 0.0
    fee_brl: float = 0.0
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

    @abc.abstractmethod
    async def count_for_tenant_since(self, tenant_id: str, since: datetime) -> int:
        """Conta os registros do tenant a partir de ``since`` (para quotas)."""


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

    async def count_for_tenant_since(self, tenant_id: str, since: datetime) -> int:
        async with self._lock:
            return sum(
                1 for r in self._records if r.tenant_id == tenant_id and r.created_at >= since
            )


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

    async def count_for_tenant_since(self, tenant_id: str, since: datetime) -> int:
        def _read() -> int:
            graph = self._ensure_graph()
            # created_at em ISO-8601: comparação lexicográfica == cronológica.
            res = graph.query(
                "MATCH (u:Usage {tenant_id: $tid}) WHERE u.created_at >= $since " "RETURN count(u)",
                {"tid": tenant_id, "since": since.isoformat()},
            )
            return int(res.result_set[0][0]) if res.result_set else 0

        return await asyncio.to_thread(_read)


class MeteringService:
    """Registra resoluções cobráveis e agrega o uso por tenant.

    Args:
        store: Persistência dos registros. Default: :class:`InMemoryMeteringStore`.
        settings: Configuração (fee de execução). Default: :func:`get_settings`.
    """

    def __init__(
        self, store: MeteringStore | None = None, settings: Settings | None = None
    ) -> None:
        self._store = store or InMemoryMeteringStore()
        self._settings = settings or get_settings()

    async def record_resolution(
        self,
        *,
        tenant_id: str,
        client_id: str,
        agents: list[str],
        duration_ms: int = 0,
        work_type: WorkType | None = None,
        value_brl: float = 0.0,
    ) -> UsageRecord:
        """Registra uma resolução e retorna o registro com o preço aplicado.

        Args:
            tenant_id: Tenant cobrado.
            client_id: Cliente final (id efetivo, já com namespace do tenant).
            agents: Agentes acionados no plano (vazio = query simples).
            duration_ms: Duração da resolução.
            work_type: Força o tipo (ex.: ``EXECUTION``); default: classificado
                a partir de ``agents``.
            value_brl: Valor movimentado (só relevante em ``EXECUTION`` —
                gera o fee sobre valor, somado ao preço base).
        """
        wt = work_type or classify_work(agents)
        fee = 0.0
        if wt is WorkType.EXECUTION and value_brl > 0:
            fee = round(value_brl * self._settings.carina_execution_fee_pct / 100, 2)
        record = UsageRecord(
            tenant_id=tenant_id,
            client_id=client_id,
            work_type=wt,
            agents=agents,
            price_brl=round(PRICE_BRL[wt] + fee, 2),
            value_brl=value_brl,
            fee_brl=fee,
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

    async def resolutions_this_month(self, tenant_id: str) -> int:
        """Resoluções do tenant no mês corrente (UTC) — base da quota mensal."""
        now = datetime.now(timezone.utc)
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        return await self._store.count_for_tenant_since(tenant_id, month_start)
