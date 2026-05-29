"""Job Modal do Monitor — vigilância 24/7 + keepalive do FalkorDB.

Deploy::

    modal deploy modal_jobs/monitor_job.py

Roda em schedule (a cada 10 min): pinga o FalkorDB (mantém a instância free ativa)
e executa um ciclo de vigilância. Segredos vêm de um Modal Secret chamado
``carina-secrets`` (espelha o ``.env``).
"""

from __future__ import annotations

import modal

app = modal.App("carina-monitor")

image = modal.Image.debian_slim(python_version="3.11").pip_install_from_pyproject("pyproject.toml")
secrets = modal.Secret.from_name("carina-secrets")


@app.function(image=image, secrets=[secrets], schedule=modal.Period(minutes=10), timeout=300)
async def monitor_tick() -> None:
    """Um ciclo: keepalive + vigilância de mercado."""
    from modal_jobs.keepalive import ping_falkordb
    from carina.utils.logging import configure_logging, get_logger

    configure_logging()
    log = get_logger("modal.monitor")

    await ping_falkordb()  # mantém FalkorDB Cloud ativo
    # TODO: percorrer clientes ativos e rodar Monitor.process por cliente.
    log.info("monitor.tick_done")
