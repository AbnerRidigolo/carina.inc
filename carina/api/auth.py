"""Autenticação da API B2B — chave de API → tenant (com rate limit por RPM).

A chave é aceita em ``Authorization: Bearer sk-...`` ou no header ``X-API-Key``.
No WebSocket (onde browsers não enviam headers custom), também é aceita no
query param ``api_key``.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request, WebSocket

from carina.api.deps import (
    get_api_key_store,
    get_limits_config,
    get_metering,
    get_rate_limiter,
)
from carina.b2b.tenants import Tenant


def _extract_key(authorization: str | None, x_api_key: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip() or None
    return x_api_key or None


async def enforce_rate_limit(tenant: Tenant) -> None:
    """Aplica o limite de requisições/minuto do tenant.

    Raises:
        HTTPException: 429 (com ``Retry-After``) quando a janela está cheia.
    """
    limiter = get_rate_limiter()
    limits = get_limits_config().for_tenant(tenant.id)
    if not await limiter.try_acquire(tenant.id, limits.rpm):
        retry_after = await limiter.retry_after(tenant.id)
        raise HTTPException(
            status_code=429,
            detail=f"Limite de {limits.rpm} requisições/min excedido",
            headers={"Retry-After": str(retry_after)},
        )


async def quota_exhausted(tenant: Tenant) -> bool:
    """``True`` se o tenant já consumiu a quota mensal de resoluções.

    Só conta resoluções (trabalho cobrável); leitura de ``/usage`` e ``/audit``
    nunca bloqueia. Quota 0 = ilimitada.
    """
    limits = get_limits_config().for_tenant(tenant.id)
    if limits.monthly_resolutions <= 0:
        return False
    used = await get_metering().resolutions_this_month(tenant.id)
    return used >= limits.monthly_resolutions


async def enforce_quota(tenant: Tenant) -> None:
    """Aplica a quota mensal de resoluções do tenant.

    Raises:
        HTTPException: 429 quando a quota do mês está esgotada.
    """
    if await quota_exhausted(tenant):
        limits = get_limits_config().for_tenant(tenant.id)
        raise HTTPException(
            status_code=429,
            detail=(
                f"Quota mensal de {limits.monthly_resolutions} resoluções esgotada — "
                "fale com o comercial para expandir o plano"
            ),
        )


async def get_current_tenant(request: Request) -> Tenant:
    """Dependência FastAPI: resolve e exige um tenant autenticado (com RPM).

    Raises:
        HTTPException: 401 quando a chave está ausente ou é inválida;
            429 quando o tenant excedeu o limite de requisições/minuto.
    """
    key = _extract_key(request.headers.get("authorization"), request.headers.get("x-api-key"))
    tenant = get_api_key_store().resolve(key)
    if tenant is None:
        raise HTTPException(status_code=401, detail="Chave de API ausente ou inválida")
    await enforce_rate_limit(tenant)
    return tenant


def resolve_ws_tenant(websocket: WebSocket) -> Tenant | None:
    """Resolve o tenant de uma conexão WebSocket (header ou ``?api_key=``)."""
    key = _extract_key(
        websocket.headers.get("authorization"), websocket.headers.get("x-api-key")
    ) or websocket.query_params.get("api_key")
    return get_api_key_store().resolve(key)


#: Atalho para uso nas rotas: ``tenant: Tenant = CurrentTenant``.
CurrentTenant = Depends(get_current_tenant)
