"""Logging estruturado para o CARINA.

Usa ``structlog`` para emitir logs em JSON (produção) ou console colorido (dev),
com contexto vinculável (``client_id``, ``agent``, ``role``). Toda ação de agente,
chamada de modelo e operação de grafo deve ser logada por aqui.
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Any

import structlog


def configure_logging(level: str | None = None, *, json_logs: bool | None = None) -> None:
    """Configura o ``structlog`` globalmente. Idempotente.

    Args:
        level: Nível mínimo (``DEBUG``/``INFO``/...). Default: ``$LOG_LEVEL`` ou ``INFO``.
        json_logs: Força saída JSON. Default: JSON quando ``CARINA_ENV != 'dev'``.
    """
    log_level = (level or os.getenv("LOG_LEVEL", "INFO")).upper()
    if json_logs is None:
        json_logs = os.getenv("CARINA_ENV", "dev") != "dev"

    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=log_level)

    renderer: structlog.types.Processor = (
        structlog.processors.JSONRenderer()
        if json_logs
        else structlog.dev.ConsoleRenderer(colors=True)
    )

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelName(log_level)),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str, **context: Any) -> structlog.stdlib.BoundLogger:
    """Retorna um logger estruturado, opcionalmente já vinculado a contexto.

    Args:
        name: Nome do logger (geralmente ``__name__`` ou o nome do agente).
        **context: Pares chave/valor vinculados a todas as mensagens deste logger.

    Returns:
        Logger ``structlog`` vinculado.
    """
    logger = structlog.get_logger(name)
    return logger.bind(**context) if context else logger
