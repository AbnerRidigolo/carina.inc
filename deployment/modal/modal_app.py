"""Agregador dos jobs Modal do CARINA.

Os jobs estão em ``modal_jobs/`` (monitor + sync). Deploy individual::

    modal deploy modal_jobs/monitor_job.py
    modal deploy modal_jobs/sync_job.py

Pré-requisito: criar o Modal Secret ``carina-secrets`` espelhando o ``.env``::

    modal secret create carina-secrets \
        NVIDIA_API_KEY=... GROQ_API_KEY=... \
        FALKORDB_HOST=... FALKORDB_PORT=6379 \
        FALKORDB_USERNAME=... FALKORDB_PASSWORD=...
"""

from __future__ import annotations

from modal_jobs.monitor_job import app as monitor_app  # noqa: F401
from modal_jobs.sync_job import app as sync_app  # noqa: F401
