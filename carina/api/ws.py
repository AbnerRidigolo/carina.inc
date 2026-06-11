"""WebSocket do CARINA — streaming de respostas dos agentes.

Autenticação B2B na conexão: ``Authorization: Bearer sk-...``, ``X-API-Key`` ou
``?api_key=`` (browsers não enviam headers custom em WebSocket). Conexão sem
tenant válido é fechada com código 4401.

Protocolo simples (JSON por mensagem):
  cliente → ``{"client_id": "...", "message": "..."}``
  servidor → ``{"type": "plan"|"result"|"error"|"done", ...}``

A mensagem ``done`` inclui ``usage`` (tipo de trabalho e preço da resolução) e
``compliance`` (flags do Watchtower).
"""

from __future__ import annotations

import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from carina.api.auth import quota_exhausted, resolve_ws_tenant
from carina.api.deps import (
    get_limits_config,
    get_metering,
    get_orchestrator,
    get_rate_limiter,
    get_watchtower,
)
from carina.b2b.tenants import scoped_client_id
from carina.utils.logging import get_logger

_log = get_logger("api.ws")
router = APIRouter()


@router.websocket("/ws/chat")
async def ws_chat(websocket: WebSocket) -> None:
    """Canal de chat por WebSocket; emite plano e resultados por agente."""
    tenant = resolve_ws_tenant(websocket)
    if tenant is None:
        await websocket.close(code=4401, reason="Chave de API ausente ou inválida")
        return

    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_json()
            client_id = data.get("client_id")
            message = data.get("message")
            if not client_id or not message:
                await websocket.send_json(
                    {"type": "error", "detail": "client_id e message obrigatórios"}
                )
                continue

            limits = get_limits_config().for_tenant(tenant.id)
            if not await get_rate_limiter().try_acquire(tenant.id, limits.rpm):
                await websocket.send_json(
                    {
                        "type": "rate_limited",
                        "detail": f"Limite de {limits.rpm} requisições/min excedido",
                        "retry_after": await get_rate_limiter().retry_after(tenant.id),
                    }
                )
                continue
            if await quota_exhausted(tenant):
                await websocket.send_json(
                    {
                        "type": "rate_limited",
                        "detail": "Quota mensal de resoluções esgotada",
                    }
                )
                continue

            effective_id = scoped_client_id(tenant, client_id)
            orch = get_orchestrator(effective_id)
            try:
                started = time.monotonic()
                outcome = await orch.handle(message)
                duration_ms = int((time.monotonic() - started) * 1000)

                await websocket.send_json({"type": "plan", "plan": outcome["plan"]})
                for agent, result in outcome["results"].items():
                    await websocket.send_json({"type": "result", "agent": agent, "result": result})

                usage = await get_metering().record_resolution(
                    tenant_id=tenant.id,
                    client_id=effective_id,
                    agents=outcome["plan"].get("agents", []),
                    duration_ms=duration_ms,
                )
                audit = await get_watchtower().review(
                    tenant_id=tenant.id,
                    client_id=effective_id,
                    query=message,
                    results=outcome["results"],
                    channel="ws",
                    duration_ms=duration_ms,
                )
                await websocket.send_json(
                    {
                        "type": "done",
                        "usage": {
                            "work_type": usage.work_type.value,
                            "price_brl": usage.price_brl,
                        },
                        "compliance": {
                            "audit_id": audit.id,
                            "flags": [f.model_dump() for f in audit.flags],
                        },
                    }
                )
            except Exception as exc:  # noqa: BLE001 - fronteira do socket
                _log.error("ws.handle_failed", error=str(exc))
                await websocket.send_json({"type": "error", "detail": str(exc)})
    except WebSocketDisconnect:
        _log.info("ws.disconnect")
