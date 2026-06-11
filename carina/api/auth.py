"""Autenticação da API B2B — chave de API → tenant.

A chave é aceita em ``Authorization: Bearer sk-...`` ou no header ``X-API-Key``.
No WebSocket (onde browsers não enviam headers custom), também é aceita no
query param ``api_key``.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request, WebSocket

from carina.api.deps import get_api_key_store
from carina.b2b.tenants import Tenant


def _extract_key(authorization: str | None, x_api_key: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip() or None
    return x_api_key or None


async def get_current_tenant(request: Request) -> Tenant:
    """Dependência FastAPI: resolve e exige um tenant autenticado.

    Raises:
        HTTPException: 401 quando a chave está ausente ou é inválida.
    """
    key = _extract_key(request.headers.get("authorization"), request.headers.get("x-api-key"))
    tenant = get_api_key_store().resolve(key)
    if tenant is None:
        raise HTTPException(status_code=401, detail="Chave de API ausente ou inválida")
    return tenant


def resolve_ws_tenant(websocket: WebSocket) -> Tenant | None:
    """Resolve o tenant de uma conexão WebSocket (header ou ``?api_key=``)."""
    key = _extract_key(
        websocket.headers.get("authorization"), websocket.headers.get("x-api-key")
    ) or websocket.query_params.get("api_key")
    return get_api_key_store().resolve(key)


#: Atalho para uso nas rotas: ``tenant: Tenant = CurrentTenant``.
CurrentTenant = Depends(get_current_tenant)
