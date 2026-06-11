"""Job Modal do Sync — consolidação Open Finance → grafo, em schedule.

Deploy::

    modal deploy modal_jobs/sync_job.py

Roda a cada 6h: para cada cliente com conexão Open Finance registrada, busca
posições e transações (últimos 30 dias) via agregador, deduplica por id de
documento e aplica ao grafo com ``apply_changes`` (1 finalize por batch).
Falha de um cliente não derruba os demais.
"""

from __future__ import annotations

import modal

app = modal.App("carina-sync")

image = modal.Image.debian_slim(python_version="3.11").pip_install_from_pyproject("pyproject.toml")
secrets = modal.Secret.from_name("carina-secrets")


@app.function(image=image, secrets=[secrets], schedule=modal.Period(hours=6), timeout=900)
async def sync_tick() -> None:
    """Um ciclo de consolidação Open Finance → grafo."""
    from datetime import date, timedelta

    from carina.agents.tier2.sync import Sync, deduplicate
    from carina.integrations.open_finance import (
        FalkorDBConnectionRegistry,
        OpenFinanceClient,
    )
    from carina.utils.logging import configure_logging, get_logger

    configure_logging()
    log = get_logger("modal.sync")

    of_client = OpenFinanceClient(registry=FalkorDBConnectionRegistry())
    since = date.today() - timedelta(days=30)

    clients = await of_client.registry.list_clients()
    for client_id in clients:
        try:
            positions = await of_client.fetch_positions(client_id)
            transactions = await of_client.fetch_transactions(client_id, since=since)

            docs = [p.to_document() for p in positions] + [t.to_document() for t in transactions]
            records = deduplicate([{"id": d.document_id, "doc": d} for d in docs], key="id")
            if not records:
                continue
            # document_id é estável → re-sync atualiza em vez de duplicar.
            await Sync(client_id).consolidate_and_apply(modified=[r["doc"] for r in records])
            log.info("sync.client_done", client_id=client_id, documents=len(records))
        except Exception as exc:  # noqa: BLE001 - um cliente não derruba o lote
            log.error("sync.client_failed", client_id=client_id, error=str(exc))

    log.info("sync.tick_done", clients=len(clients))
