"""Cliente Open Finance (stub) — consolidação de posições/transações para o Sync.

Stub assíncrono com a fronteira tipada. A implementação real chama as APIs de Open
Finance (consentimento, contas, posições). Credenciais via :class:`Settings`.
"""

from __future__ import annotations

from carina.config.settings import Settings, get_settings
from carina.utils.logging import get_logger

_log = get_logger("integrations.open_finance")


class OpenFinanceClient:
    """Cliente de Open Finance (a implementar)."""

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()

    async def fetch_positions(self, client_id: str) -> list[dict]:
        """Busca posições consolidadas do cliente (stub).

        Returns:
            Lista de posições no formato bruto das instituições.
        """
        _log.info("open_finance.fetch_positions", client_id=client_id)
        # TODO: integrar com as APIs de Open Finance (consentimento + dados).
        return []

    async def fetch_transactions(self, client_id: str) -> list[dict]:
        """Busca transações consolidadas do cliente (stub)."""
        _log.info("open_finance.fetch_transactions", client_id=client_id)
        return []
