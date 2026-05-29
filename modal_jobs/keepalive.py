"""Keepalive do FalkorDB Cloud.

A instância free do FalkorDB Cloud é PARADA após 1 dia ociosa e DELETADA após 7.
Esta função faz um ping leve no grafo para manter uso contínuo. É chamada pelo
Monitor job (ver :mod:`modal_jobs.monitor_job`), que roda no Modal 24/7.
"""

from __future__ import annotations

import asyncio

from carina.config.settings import get_settings
from carina.utils.logging import get_logger

_log = get_logger("keepalive")


async def ping_falkordb() -> bool:
    """Executa uma query trivial no FalkorDB para manter a instância ativa.

    Returns:
        ``True`` se o ping teve sucesso.
    """
    settings = get_settings()
    settings.require_falkordb()

    def _ping() -> bool:
        from falkordb import FalkorDB

        db = FalkorDB(
            host=settings.falkordb_host,
            port=settings.falkordb_port,
            username=settings.falkordb_username or None,
            password=settings.falkordb_password or None,
        )
        graph = db.select_graph("carina_keepalive")
        graph.query("RETURN 1")
        return True

    try:
        ok = await asyncio.to_thread(_ping)
        _log.info("keepalive.ping", ok=ok)
        return ok
    except Exception as exc:  # noqa: BLE001 - keepalive não deve derrubar o job
        _log.error("keepalive.failed", error=str(exc))
        return False
