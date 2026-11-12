"""Job Modal dos AOPs — executa os procedimentos agendados dos tenants B2B.

Deploy::

    modal deploy modal_jobs/aops_job.py

Roda em schedule (a cada 15 min): varre os AOPs habilitados no FalkorDB e
executa os que venceram (``Schedule.is_due``). Cada execução por cliente é
medida (metering) e auditada (Watchtower) automaticamente pelo serviço.
Segredos vêm do Modal Secret ``carina-secrets`` (espelha o ``.env``).
"""

from __future__ import annotations

import modal

app = modal.App("carina-aops")

image = modal.Image.debian_slim(python_version="3.11").pip_install_from_pyproject("pyproject.toml")
secrets = modal.Secret.from_name("carina-secrets")


@app.function(image=image, secrets=[secrets], schedule=modal.Period(minutes=15), timeout=900)
async def aops_tick() -> None:
    """Um ciclo: executa todos os AOPs habilitados cujo disparo venceu."""
    from carina.b2b.aops import AOPService, FalkorDBAOPStore
    from carina.b2b.metering import FalkorDBMeteringStore, MeteringService
    from carina.b2b.watchtower import FalkorDBAuditStore, Watchtower
    from carina.models.router import get_router
    from carina.utils.logging import configure_logging, get_logger

    configure_logging()
    log = get_logger("modal.aops")

    service = AOPService(
        store=FalkorDBAOPStore(),
        router=get_router(),
        metering=MeteringService(store=FalkorDBMeteringStore()),
        watchtower=Watchtower(store=FalkorDBAuditStore()),
    )
    executed = await service.run_due()
    log.info("aops.tick_done", executed=len(executed))
