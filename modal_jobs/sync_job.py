"""Job Modal do Sync — consolidação Open Finance → grafo, em schedule.

Deploy::

    modal deploy modal_jobs/sync_job.py

Roda periodicamente (ex.: a cada 6h): para cada cliente ativo, busca dados via Open
Finance, deduplica e aplica ao grafo com ``apply_changes`` (1 finalize por batch).
"""

from __future__ import annotations

import modal

app = modal.App("carina-sync")

image = modal.Image.debian_slim(python_version="3.11").pip_install_from_pyproject("pyproject.toml")
secrets = modal.Secret.from_name("carina-secrets")


@app.function(image=image, secrets=[secrets], schedule=modal.Period(hours=6), timeout=900)
async def sync_tick() -> None:
    """Um ciclo de consolidação Open Finance → grafo."""
    from carina.utils.logging import configure_logging, get_logger

    configure_logging()
    log = get_logger("modal.sync")
    # TODO: para cada client_id ativo:
    #   1) OpenFinanceClient.fetch_positions/transactions
    #   2) deduplicate()
    #   3) Sync.consolidate_and_apply(added=..., modified=..., deleted=...)
    log.info("sync.tick_done")
