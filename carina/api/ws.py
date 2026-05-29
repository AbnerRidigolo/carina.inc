"""WebSocket do CARINA — streaming de respostas dos agentes.

Protocolo simples (JSON por mensagem):
  cliente → ``{"client_id": "...", "message": "..."}``
  servidor → ``{"type": "plan"|"result"|"error"|"done", ...}``
"""

from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from carina.api.deps import get_orchestrator
from carina.utils.logging import get_logger

_log = get_logger("api.ws")
router = APIRouter()


@router.websocket("/ws/chat")
async def ws_chat(websocket: WebSocket) -> None:
    """Canal de chat por WebSocket; emite plano e resultados por agente."""
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

            orch = get_orchestrator(client_id)
            try:
                outcome = await orch.handle(message)
                await websocket.send_json({"type": "plan", "plan": outcome["plan"]})
                for agent, result in outcome["results"].items():
                    await websocket.send_json({"type": "result", "agent": agent, "result": result})
                await websocket.send_json({"type": "done"})
            except Exception as exc:  # noqa: BLE001 - fronteira do socket
                _log.error("ws.handle_failed", error=str(exc))
                await websocket.send_json({"type": "error", "detail": str(exc)})
    except WebSocketDisconnect:
        _log.info("ws.disconnect")
