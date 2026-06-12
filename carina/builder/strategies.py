"""Registro de estratégias declarativas por tenant (Builder Layer).

Estratégias são ESPECIFICAÇÕES validadas (:class:`StrategySpec`), nunca código
do builder — a Builder Layer é regulada e auditável por construção. O backtest
roda sobre o Market Data BR normalizado (Camada 1 do Data Engine).
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, model_validator

from carina.builder.backtest import BacktestResult, run_backtest
from carina.config.settings import Settings, get_settings
from carina.data_engine.market_data import MarketDataService
from carina.utils.logging import get_logger

_log = get_logger("builder.strategies")


class StrategyKind(str, Enum):
    """Tipos de estratégia declarativa suportados no MVP."""

    BUY_HOLD = "buy_hold"
    SMA_CROSS = "sma_cross"


class StrategySpec(BaseModel):
    """Especificação declarativa de uma estratégia (validada na criação)."""

    kind: StrategyKind
    symbol: str = Field(min_length=1, description="Símbolo B3 (ex.: PETR4, BOVA11).")
    fast: int = Field(default=10, ge=2, le=200, description="Janela rápida (sma_cross).")
    slow: int = Field(default=50, ge=3, le=400, description="Janela lenta (sma_cross).")

    @model_validator(mode="after")
    def _validate_windows(self) -> "StrategySpec":
        if self.kind is StrategyKind.SMA_CROSS and self.fast >= self.slow:
            raise ValueError("janela rápida deve ser menor que a lenta (fast < slow)")
        return self


class Strategy(BaseModel):
    """Estratégia registrada por um tenant."""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    tenant_id: str
    name: str = Field(min_length=1)
    spec: StrategySpec
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class StrategyStore:
    """Persistência de estratégias (em memória — dev/testes)."""

    def __init__(self) -> None:
        self._data: dict[str, Strategy] = {}
        self._lock = asyncio.Lock()

    async def save(self, strategy: Strategy) -> None:
        async with self._lock:
            self._data[strategy.id] = strategy.model_copy(deep=True)

    async def get(self, strategy_id: str) -> Strategy | None:
        async with self._lock:
            found = self._data.get(strategy_id)
            return found.model_copy(deep=True) if found else None

    async def list_for_tenant(self, tenant_id: str) -> list[Strategy]:
        async with self._lock:
            return [
                s.model_copy(deep=True) for s in self._data.values() if s.tenant_id == tenant_id
            ]


class FalkorDBStrategyStore(StrategyStore):
    """Persistência num grafo dedicado ``carina_strategies`` (produção)."""

    def __init__(self, settings: Settings | None = None, graph_name: str = "carina_strategies"):
        super().__init__()
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

    async def save(self, strategy: Strategy) -> None:
        payload = strategy.model_dump_json()

        def _write() -> None:
            self._ensure_graph().query(
                "MERGE (s:Strategy {id: $id}) SET s.tenant_id = $tid, s.json = $json",
                {"id": strategy.id, "tid": strategy.tenant_id, "json": payload},
            )

        await asyncio.to_thread(_write)

    async def get(self, strategy_id: str) -> Strategy | None:
        def _read() -> str | None:
            res = self._ensure_graph().query(
                "MATCH (s:Strategy {id: $id}) RETURN s.json", {"id": strategy_id}
            )
            return res.result_set[0][0] if res.result_set else None

        raw = await asyncio.to_thread(_read)
        return Strategy.model_validate_json(raw) if raw else None

    async def list_for_tenant(self, tenant_id: str) -> list[Strategy]:
        def _read() -> list[str]:
            res = self._ensure_graph().query(
                "MATCH (s:Strategy {tenant_id: $tid}) RETURN s.json", {"tid": tenant_id}
            )
            return [row[0] for row in res.result_set]

        rows = await asyncio.to_thread(_read)
        return [Strategy.model_validate_json(r) for r in rows]


class BuilderService:
    """Cria estratégias e roda backtests sobre o Market Data normalizado.

    Args:
        store: Persistência. Default: :class:`StrategyStore` (memória).
        market_data: Fonte de histórico. Default: novo :class:`MarketDataService`.
    """

    def __init__(
        self,
        store: StrategyStore | None = None,
        market_data: MarketDataService | None = None,
    ) -> None:
        self._store = store or StrategyStore()
        self._market_data = market_data or MarketDataService()

    async def create(self, *, tenant_id: str, name: str, spec: StrategySpec) -> Strategy:
        """Registra uma estratégia validada para o tenant."""
        strategy = Strategy(tenant_id=tenant_id, name=name, spec=spec)
        await self._store.save(strategy)
        _log.info(
            "builder.strategy_created",
            strategy_id=strategy.id,
            tenant_id=tenant_id,
            kind=spec.kind.value,
        )
        return strategy

    async def get(self, strategy_id: str) -> Strategy | None:
        """Retorna uma estratégia pelo id (ou ``None``)."""
        return await self._store.get(strategy_id)

    async def list_for_tenant(self, tenant_id: str) -> list[Strategy]:
        """Lista as estratégias de um tenant."""
        return await self._store.list_for_tenant(tenant_id)

    async def backtest(self, strategy: Strategy, range_: str = "1y") -> BacktestResult:
        """Roda o backtest da estratégia com histórico da Camada 1.

        Raises:
            BuilderError: Histórico insuficiente para a especificação.
        """
        bars = await self._market_data.history(strategy.spec.symbol, range_=range_)
        return run_backtest(
            kind=strategy.spec.kind.value,
            symbol=strategy.spec.symbol,
            bars=bars,
            fast=strategy.spec.fast,
            slow=strategy.spec.slow,
        )
