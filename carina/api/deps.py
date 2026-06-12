"""Dependências compartilhadas da API (singletons de processo).

Mantém uma única :class:`InboxService` e :class:`ModelRouter` por processo, um
cache de :class:`Orchestrator` por ``client_id`` (cada cliente tem seu grafo) e
os serviços B2B (chaves de API, metering, Watchtower). Em produção os serviços
B2B usam os stores FalkorDB (append-only); em dev, memória.
"""

from __future__ import annotations

from functools import lru_cache

from carina.agents.orchestrator import Orchestrator
from carina.b2b.aops import AOPService, FalkorDBAOPStore
from carina.b2b.metering import FalkorDBMeteringStore, MeteringService
from carina.b2b.ratelimit import LimitsConfig, RateLimiter
from carina.b2b.tenants import ApiKeyStore
from carina.b2b.watchtower import FalkorDBAuditStore, Watchtower
from carina.builder.strategies import BuilderService, FalkorDBStrategyStore
from carina.config.settings import get_settings
from carina.data_engine.evaluation import EvaluationService
from carina.data_engine.market_data import MarketDataService
from carina.inbox.service import InboxService
from carina.integrations.notify import Notifier, inbox_notifier
from carina.integrations.open_finance import FalkorDBConnectionRegistry, OpenFinanceClient
from carina.models.router import ModelRouter, get_router


@lru_cache
def get_notifier() -> Notifier:
    """Notificador (WhatsApp/e-mail) único do processo."""
    return Notifier()


@lru_cache
def get_inbox() -> InboxService:
    """Serviço de inbox único do processo (notifica reversíveis executadas)."""
    return InboxService(notifier=inbox_notifier(get_notifier()))


@lru_cache
def get_orchestrator(client_id: str) -> Orchestrator:
    """Orchestrator (cacheado) para um cliente."""
    router: ModelRouter = get_router()
    return Orchestrator(client_id=client_id, router=router)


@lru_cache
def get_api_key_store() -> ApiKeyStore:
    """Store de chaves de API B2B único do processo."""
    return ApiKeyStore()


@lru_cache
def get_metering() -> MeteringService:
    """Serviço de metering único do processo (FalkorDB em produção)."""
    if get_settings().is_production:
        return MeteringService(store=FalkorDBMeteringStore())
    return MeteringService()


@lru_cache
def get_watchtower() -> Watchtower:
    """Watchtower único do processo (FalkorDB em produção)."""
    if get_settings().is_production:
        return Watchtower(store=FalkorDBAuditStore())
    return Watchtower()


@lru_cache
def get_limits_config() -> LimitsConfig:
    """Limites por tenant (RPM e quota mensal) únicos do processo."""
    return LimitsConfig()


@lru_cache
def get_rate_limiter() -> RateLimiter:
    """Rate limiter único do processo (janela deslizante em memória)."""
    return RateLimiter()


@lru_cache
def get_aop_service() -> AOPService:
    """Serviço de AOPs único do processo (compartilha metering e Watchtower)."""
    store = FalkorDBAOPStore() if get_settings().is_production else None
    return AOPService(
        store=store,
        router=get_router(),
        metering=get_metering(),
        watchtower=get_watchtower(),
    )


@lru_cache
def get_open_finance() -> OpenFinanceClient:
    """Cliente Open Finance único do processo (registro FalkorDB em produção)."""
    registry = FalkorDBConnectionRegistry() if get_settings().is_production else None
    return OpenFinanceClient(registry=registry)


@lru_cache
def get_market_data() -> MarketDataService:
    """Market Data BR único do processo (Data Engine — Camada 1)."""
    return MarketDataService()


@lru_cache
def get_evaluation() -> EvaluationService:
    """Benchmark SEAL BR único do processo (Data Engine — Camada 3)."""
    return EvaluationService()


@lru_cache
def get_builder() -> BuilderService:
    """Builder Layer única do processo (FalkorDB em produção)."""
    store = FalkorDBStrategyStore() if get_settings().is_production else None
    return BuilderService(store=store, market_data=get_market_data())
