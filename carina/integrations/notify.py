"""Notificações ao cliente/assessor (WhatsApp e e-mail) — stubs assíncronos.

Usados pela agentic-inbox (notificar ações reversíveis) e pelo Assessor Liaison.
Implementação real via provedores externos; credenciais via :class:`Settings`.
"""

from __future__ import annotations

from carina.config.settings import Settings, get_settings
from carina.utils.logging import get_logger

_log = get_logger("integrations.notify")


class Notifier:
    """Envia notificações por WhatsApp/e-mail (a implementar)."""

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()

    async def whatsapp(self, to: str, text: str) -> None:
        """Envia mensagem WhatsApp (stub)."""
        _log.info("notify.whatsapp", to=to)
        # TODO: integrar provedor (token em Settings.whatsapp_token).

    async def email(self, to: str, subject: str, body: str) -> None:
        """Envia e-mail (stub)."""
        _log.info("notify.email", to=to, subject=subject)
        # TODO: integrar SMTP (Settings.smtp_*).
