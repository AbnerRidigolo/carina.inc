"""Rotas REST do CARINA (FastAPI).

Todas as rotas (exceto ``/health``) exigem chave de API B2B e operam no
namespace do tenant autenticado: o ``client_id`` recebido é prefixado com o id
do tenant antes de tocar grafo, inbox ou metering. Cada ``/chat`` atendido é
medido (precificação por resolução) e auditado pelo Watchtower.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from carina.api.auth import CurrentTenant, enforce_quota
from carina.api.deps import (
    get_aop_service,
    get_builder,
    get_evaluation,
    get_inbox,
    get_market_data,
    get_metering,
    get_open_finance,
    get_orchestrator,
    get_watchtower,
)
from carina.b2b.metering import WorkType, extract_value_brl
from carina.b2b.tenants import Tenant, owns_client, scoped_client_id
from carina.builder.strategies import StrategySpec
from carina.data_engine.evaluation import EvalCategory
from carina.utils.errors import AOPError, BuilderError, InboxError, IntegrationError
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


class AOPCreateRequest(BaseModel):
    """Criação de um AOP a partir de linguagem natural."""

    text: str = Field(min_length=1, description="Procedimento em linguagem natural.")
    client_ids: list[str] = Field(min_length=1)
    name: str | None = None


class AOPUpdateRequest(BaseModel):
    """Atualização de estado de um AOP."""

    enabled: bool


class ConnectionRequest(BaseModel):
    """Registro de uma conexão Open Finance consentida (item do agregador)."""

    item_id: str = Field(min_length=1)


class EvalSubmitRequest(BaseModel):
    """Respostas de um agente para correção no benchmark SEAL BR."""

    answers: dict[str, str] = Field(min_length=1, description="{case_id: resposta do agente}.")


class StrategyCreateRequest(BaseModel):
    """Registro de uma estratégia declarativa (Builder Layer)."""

    name: str = Field(min_length=1)
    spec: StrategySpec


def _scoped(tenant: Tenant, client_id: str) -> str:
    """``scoped_client_id`` com fronteira HTTP: client_id inválido → 422."""
    try:
        return scoped_client_id(tenant, client_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/health")
async def health() -> dict:
    """Liveness simples."""
    return {"status": "ok"}


@router.post("/chat")
async def chat(req: ChatRequest, tenant: Tenant = CurrentTenant) -> dict:
    """Processa uma mensagem via Orchestrator, com metering e auditoria."""
    await enforce_quota(tenant)
    effective_id = _scoped(tenant, req.client_id)
    orch = get_orchestrator(effective_id)

    started = time.monotonic()
    outcome = await orch.handle(req.message)
    duration_ms = int((time.monotonic() - started) * 1000)

    agents = outcome["plan"].get("agents", [])
    usage = await get_metering().record_resolution(
        tenant_id=tenant.id,
        client_id=effective_id,
        agents=agents,
        duration_ms=duration_ms,
    )
    audit = await get_watchtower().review(
        tenant_id=tenant.id,
        client_id=effective_id,
        query=req.message,
        results=outcome["results"],
        channel="rest",
        duration_ms=duration_ms,
    )

    return {
        **outcome,
        "usage": {"work_type": usage.work_type.value, "price_brl": usage.price_brl},
        "compliance": {
            "audit_id": audit.id,
            "flags": [f.model_dump() for f in audit.flags],
        },
    }


@router.get("/clients/{client_id}/inbox")
async def list_inbox(client_id: str, tenant: Tenant = CurrentTenant) -> dict:
    """Lista as aprovações pendentes de um cliente (escopo do tenant)."""
    effective_id = _scoped(tenant, client_id)
    pending = await get_inbox().list_pending(effective_id)
    return {"pending": [p.model_dump(mode="json") for p in pending]}


@router.post("/inbox/{request_id}/decision")
async def decide(request_id: str, body: DecisionRequest, tenant: Tenant = CurrentTenant) -> dict:
    """Aplica a decisão humana (aprovar/rejeitar) a uma solicitação do tenant.

    Aprovação executada de ação irreversível é uma resolução ``EXECUTION``:
    preço base + fee sobre o valor movimentado (rejeição não cobra).
    """
    request = await get_inbox().get(request_id)
    # 404 (e não 403) para não revelar a existência de solicitações de outros tenants.
    if request is None or not owns_client(tenant, request.client_id):
        raise HTTPException(status_code=404, detail="Solicitação não encontrada")
    try:
        outcome = await get_inbox().decide(
            request_id,
            approved=body.approved,
            decided_by=body.decided_by,
            reason=body.reason,
        )
    except InboxError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    if outcome.get("status") == "executed":
        usage = await get_metering().record_resolution(
            tenant_id=tenant.id,
            client_id=request.client_id,
            agents=[request.agent.lower()],
            work_type=WorkType.EXECUTION,
            value_brl=extract_value_brl(request.payload),
        )
        outcome["usage"] = {
            "work_type": usage.work_type.value,
            "price_brl": usage.price_brl,
            "fee_brl": usage.fee_brl,
        }
    return outcome


@router.get("/usage")
async def usage(tenant: Tenant = CurrentTenant) -> dict:
    """Resumo de uso e cobrança do tenant (precificação por resolução)."""
    return await get_metering().summary(tenant.id)


@router.get("/audit")
async def audit_trail(limit: int = 100, tenant: Tenant = CurrentTenant) -> dict:
    """Trilha de auditoria do Watchtower para o tenant."""
    events = await get_watchtower().trail(tenant.id, limit=min(limit, 500))
    return {"events": [e.model_dump(mode="json") for e in events]}


async def _owned_aop(aop_id: str, tenant: Tenant):
    """Resolve um AOP do tenant; 404 se não existir ou for de outro tenant."""
    aop = await get_aop_service().get(aop_id)
    if aop is None or aop.tenant_id != tenant.id:
        raise HTTPException(status_code=404, detail="AOP não encontrado")
    return aop


@router.post("/aops", status_code=201)
async def create_aop(body: AOPCreateRequest, tenant: Tenant = CurrentTenant) -> dict:
    """Cria um AOP a partir da descrição em linguagem natural."""
    try:
        aop = await get_aop_service().create_from_text(
            tenant_id=tenant.id, text=body.text, client_ids=body.client_ids, name=body.name
        )
    except AOPError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return aop.model_dump(mode="json")


@router.get("/aops")
async def list_aops(tenant: Tenant = CurrentTenant) -> dict:
    """Lista os AOPs do tenant."""
    aops = await get_aop_service().list_for_tenant(tenant.id)
    return {"aops": [a.model_dump(mode="json") for a in aops]}


@router.post("/aops/{aop_id}/run")
async def run_aop(aop_id: str, tenant: Tenant = CurrentTenant) -> dict:
    """Executa um AOP agora (fora da agenda) para os clientes-alvo."""
    await enforce_quota(tenant)
    aop = await _owned_aop(aop_id, tenant)
    try:
        return await get_aop_service().run(aop)
    except AOPError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.patch("/aops/{aop_id}")
async def update_aop(aop_id: str, body: AOPUpdateRequest, tenant: Tenant = CurrentTenant) -> dict:
    """Habilita/desabilita um AOP."""
    await _owned_aop(aop_id, tenant)
    aop = await get_aop_service().set_enabled(aop_id, body.enabled)
    return aop.model_dump(mode="json")


@router.post("/clients/{client_id}/connections", status_code=201)
async def add_connection(
    client_id: str, body: ConnectionRequest, tenant: Tenant = CurrentTenant
) -> dict:
    """Registra uma conexão Open Finance consentida do cliente."""
    effective_id = _scoped(tenant, client_id)
    await get_open_finance().registry.add(effective_id, body.item_id)
    return {"client_id": client_id, "item_id": body.item_id}


@router.get("/clients/{client_id}/connections")
async def list_connections(client_id: str, tenant: Tenant = CurrentTenant) -> dict:
    """Lista as conexões Open Finance do cliente (escopo do tenant)."""
    effective_id = _scoped(tenant, client_id)
    return {"item_ids": await get_open_finance().registry.list_items(effective_id)}


@router.delete("/clients/{client_id}/connections/{item_id}")
async def remove_connection(client_id: str, item_id: str, tenant: Tenant = CurrentTenant) -> dict:
    """Remove uma conexão Open Finance do cliente."""
    effective_id = _scoped(tenant, client_id)
    removed = await get_open_finance().registry.remove(effective_id, item_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Conexão não encontrada")
    return {"removed": True}


@router.get("/clients/{client_id}/positions")
async def list_positions(client_id: str, tenant: Tenant = CurrentTenant) -> dict:
    """Posições consolidadas (Open Finance) de todas as conexões do cliente."""
    effective_id = _scoped(tenant, client_id)
    try:
        positions = await get_open_finance().fetch_positions(effective_id)
    except IntegrationError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"positions": [p.model_dump(mode="json") for p in positions]}


@router.get("/clients/{client_id}/transactions")
async def list_transactions(client_id: str, tenant: Tenant = CurrentTenant) -> dict:
    """Transações consolidadas (Open Finance) de todas as conexões do cliente."""
    effective_id = _scoped(tenant, client_id)
    try:
        transactions = await get_open_finance().fetch_transactions(effective_id)
    except IntegrationError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"transactions": [t.model_dump(mode="json") for t in transactions]}


async def _record_data_query(tenant: Tenant) -> dict:
    """Medição de uma chamada do Data Engine (SaaS por volume de chamadas)."""
    usage = await get_metering().record_resolution(
        tenant_id=tenant.id,
        client_id=tenant.id,  # dado de mercado é por tenant, não por cliente final
        agents=[],
        work_type=WorkType.DATA_QUERY,
    )
    return {"work_type": usage.work_type.value, "price_brl": usage.price_brl}


@router.get("/market/quotes")
async def market_quotes(symbols: str, tenant: Tenant = CurrentTenant) -> dict:
    """Cotações B3 normalizadas (símbolos separados por vírgula)."""
    requested = [s for s in symbols.split(",") if s.strip()]
    if not requested:
        raise HTTPException(status_code=422, detail="Informe ao menos um símbolo")
    try:
        quotes = await get_market_data().quotes(requested)
    except IntegrationError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "quotes": [q.model_dump(mode="json") for q in quotes],
        "usage": await _record_data_query(tenant),
    }


@router.get("/market/history/{symbol}")
async def market_history(symbol: str, range: str = "3mo", tenant: Tenant = CurrentTenant) -> dict:
    """Histórico diário OHLCV normalizado de um símbolo B3."""
    try:
        bars = await get_market_data().history(symbol, range_=range)
    except IntegrationError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "symbol": symbol.upper().strip(),
        "range": range,
        "bars": [b.model_dump(mode="json") for b in bars],
        "usage": await _record_data_query(tenant),
    }


@router.get("/market/macro")
async def market_macro(tenant: Tenant = CurrentTenant) -> dict:
    """Indicadores macro BCB normalizados (Selic, CDI, IPCA, PTAX)."""
    try:
        indicators = await get_market_data().macro()
    except IntegrationError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "indicators": [i.model_dump(mode="json") for i in indicators],
        "usage": await _record_data_query(tenant),
    }


@router.get("/eval/cases")
async def eval_catalog(category: str | None = None, tenant: Tenant = CurrentTenant) -> dict:
    """Catálogo do benchmark SEAL BR — perguntas SEM gabarito."""
    parsed: EvalCategory | None = None
    if category is not None:
        try:
            parsed = EvalCategory(category)
        except ValueError as exc:
            valid = ", ".join(c.value for c in EvalCategory)
            raise HTTPException(
                status_code=422, detail=f"Categoria inválida — use uma de: {valid}"
            ) from exc
    return {"cases": get_evaluation().catalog(parsed)}


@router.post("/eval/submit")
async def eval_submit(body: EvalSubmitRequest, tenant: Tenant = CurrentTenant) -> dict:
    """Corrige as respostas de um agente contra o benchmark (execução cobrável)."""
    await enforce_quota(tenant)
    try:
        report = get_evaluation().evaluate(body.answers)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    usage = await get_metering().record_resolution(
        tenant_id=tenant.id,
        client_id=tenant.id,  # benchmark é por tenant, não por cliente final
        agents=[],
        work_type=WorkType.EVALUATION,
    )
    return {
        **report.model_dump(mode="json"),
        "usage": {"work_type": usage.work_type.value, "price_brl": usage.price_brl},
    }


async def _owned_strategy(strategy_id: str, tenant: Tenant):
    """Resolve uma estratégia do tenant; 404 se não existir ou for de outro."""
    strategy = await get_builder().get(strategy_id)
    if strategy is None or strategy.tenant_id != tenant.id:
        raise HTTPException(status_code=404, detail="Estratégia não encontrada")
    return strategy


@router.post("/builder/strategies", status_code=201)
async def create_strategy(body: StrategyCreateRequest, tenant: Tenant = CurrentTenant) -> dict:
    """Registra uma estratégia declarativa do tenant (Builder Layer)."""
    strategy = await get_builder().create(tenant_id=tenant.id, name=body.name, spec=body.spec)
    return strategy.model_dump(mode="json")


@router.get("/builder/strategies")
async def list_strategies(tenant: Tenant = CurrentTenant) -> dict:
    """Lista as estratégias registradas do tenant."""
    strategies = await get_builder().list_for_tenant(tenant.id)
    return {"strategies": [s.model_dump(mode="json") for s in strategies]}


@router.post("/builder/strategies/{strategy_id}/backtest")
async def backtest_strategy(
    strategy_id: str, range: str = "1y", tenant: Tenant = CurrentTenant
) -> dict:
    """Roda o backtest de uma estratégia sobre o Market Data BR (cobrável)."""
    await enforce_quota(tenant)
    strategy = await _owned_strategy(strategy_id, tenant)
    try:
        result = await get_builder().backtest(strategy, range_=range)
    except BuilderError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except IntegrationError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    usage = await get_metering().record_resolution(
        tenant_id=tenant.id,
        client_id=tenant.id,  # backtest é por tenant, não por cliente final
        agents=[],
        work_type=WorkType.BACKTEST,
    )
    return {
        **result.model_dump(mode="json"),
        "usage": {"work_type": usage.work_type.value, "price_brl": usage.price_brl},
    }
