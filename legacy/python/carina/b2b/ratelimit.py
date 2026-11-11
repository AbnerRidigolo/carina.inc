"""Rate limiting e quotas por tenant B2B.

Dois controles independentes:
  * **RPM** (requisições por minuto): janela deslizante em memória, aplicada a
    toda a API autenticada. Protege a infraestrutura contra abuso/spam.
  * **Quota mensal de resoluções**: verificada contra o metering, aplicada
    apenas aos endpoints que geram trabalho cobrável (``/chat``, execução de
    AOP). Endpoints de leitura (``/usage``, ``/audit``) nunca bloqueiam por
    quota — o tenant sempre consegue ver a própria conta.

Limites por tenant vêm de ``CARINA_TENANT_LIMITS`` no formato::

    acme:120:5000;warren:60:1000    # tenant:rpm:resoluções/mês

Tenants ausentes usam os defaults (``CARINA_DEFAULT_RPM``,
``CARINA_DEFAULT_MONTHLY_QUOTA``; quota 0 = ilimitada).

Limitação conhecida: o contador de RPM é por processo. Com múltiplas réplicas
da API, o limite efetivo é ``rpm × réplicas`` — aceitável para o MVP; um
backend compartilhado (Redis) entra quando houver escala horizontal.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import Callable

from pydantic import BaseModel, Field

from carina.config.settings import Settings, get_settings
from carina.utils.logging import get_logger

_log = get_logger(__name__)

_WINDOW_SECONDS = 60.0


class TenantLimits(BaseModel):
    """Limites efetivos de um tenant."""

    rpm: int = Field(gt=0)
    monthly_resolutions: int = Field(ge=0, description="0 = ilimitado.")


class LimitsConfig:
    """Resolve os limites de cada tenant (overrides + defaults).

    Args:
        settings: Configuração (lê ``CARINA_TENANT_LIMITS`` e defaults).
            Default: :func:`get_settings`.
    """

    def __init__(self, settings: Settings | None = None) -> None:
        s = settings or get_settings()
        self._default = TenantLimits(
            rpm=s.carina_default_rpm,
            monthly_resolutions=s.carina_default_monthly_quota,
        )
        self._overrides: dict[str, TenantLimits] = {}
        self._parse(s.carina_tenant_limits)

    def _parse(self, raw: str) -> None:
        for entry in filter(None, (e.strip() for e in raw.split(";"))):
            parts = entry.split(":")
            try:
                tenant_id, rpm = parts[0], int(parts[1])
                quota = int(parts[2]) if len(parts) > 2 else self._default.monthly_resolutions
                self._overrides[tenant_id] = TenantLimits(rpm=rpm, monthly_resolutions=quota)
            except (IndexError, ValueError):
                _log.warning("limits.entry_invalid", entry=entry)

    def for_tenant(self, tenant_id: str) -> TenantLimits:
        """Limites efetivos do tenant (override ou default)."""
        return self._overrides.get(tenant_id, self._default)


class RateLimiter:
    """Janela deslizante de 60s por tenant (em memória).

    Args:
        now_fn: Relógio monotônico injetável (testes). Default: ``time.monotonic``.
    """

    def __init__(self, now_fn: Callable[[], float] = time.monotonic) -> None:
        self._now = now_fn
        self._events: dict[str, deque[float]] = {}
        self._lock = asyncio.Lock()

    async def try_acquire(self, tenant_id: str, rpm: int) -> bool:
        """Registra a requisição se houver espaço na janela; ``False`` se excedeu."""
        now = self._now()
        async with self._lock:
            window = self._events.setdefault(tenant_id, deque())
            while window and now - window[0] >= _WINDOW_SECONDS:
                window.popleft()
            if len(window) >= rpm:
                return False
            window.append(now)
            return True

    async def retry_after(self, tenant_id: str) -> int:
        """Segundos até a janela liberar a próxima requisição (mínimo 1)."""
        async with self._lock:
            window = self._events.get(tenant_id)
            if not window:
                return 1
            return max(1, int(_WINDOW_SECONDS - (self._now() - window[0])) + 1)
