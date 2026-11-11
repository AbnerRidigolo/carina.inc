"""Notificações ao cliente/assessor — WhatsApp (Meta Cloud API) e e-mail (SMTP).

Usadas pela agentic-inbox (notificar ações reversíveis executadas e aprovações)
e pelo Assessor Liaison. Arquitetura em canais: :class:`WhatsAppChannel` e
:class:`EmailChannel` são independentes; o :class:`Notifier` orquestra com
resiliência — falha de um canal não impede o outro, e falha de notificação
NUNCA derruba a ação que a originou.

Contato do destinatário viaja no payload da ação (``payload["notify"]`` com
``email`` e/ou ``whatsapp``) — sem registro central de contatos no MVP.
"""

from __future__ import annotations

import asyncio
import smtplib
from email.message import EmailMessage

import httpx

from carina.config.settings import Settings, get_settings
from carina.inbox.models import ApprovalRequest
from carina.utils.errors import IntegrationError
from carina.utils.logging import get_logger

_log = get_logger("integrations.notify")

_HTTP_TIMEOUT = 30.0


class WhatsAppChannel:
    """Envio de texto via Meta WhatsApp Cloud API.

    Requer ``WHATSAPP_TOKEN`` e ``WHATSAPP_PHONE_NUMBER_ID`` (o número
    remetente registrado no app Meta).

    Args:
        settings: Credenciais e base URL.
        http: Cliente httpx injetável (testes).
    """

    def __init__(self, settings: Settings | None = None, http: httpx.AsyncClient | None = None):
        self._settings = settings or get_settings()
        self._http = http or httpx.AsyncClient(timeout=_HTTP_TIMEOUT)

    async def send(self, to: str, text: str) -> None:
        """Envia uma mensagem de texto.

        Raises:
            IntegrationError: Credenciais ausentes ou falha no envio.
        """
        s = self._settings
        if not s.whatsapp_token or not s.whatsapp_phone_number_id:
            raise IntegrationError(
                "WhatsApp não configurado — defina WHATSAPP_TOKEN e "
                "WHATSAPP_PHONE_NUMBER_ID no .env"
            )
        base = s.whatsapp_base_url.rstrip("/")
        resp = await self._http.post(
            f"{base}/{s.whatsapp_phone_number_id}/messages",
            headers={"Authorization": f"Bearer {s.whatsapp_token}"},
            json={
                "messaging_product": "whatsapp",
                "to": to,
                "type": "text",
                "text": {"body": text},
            },
        )
        if resp.status_code != 200:
            raise IntegrationError(f"WhatsApp Cloud API: HTTP {resp.status_code}")
        _log.info("notify.whatsapp_sent", to=to)


class EmailChannel:
    """Envio de e-mail via SMTP (STARTTLS quando há credenciais).

    O I/O síncrono do ``smtplib`` roda em thread (``asyncio.to_thread``) para
    não bloquear o event loop.
    """

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()

    async def send(self, to: str, subject: str, body: str) -> None:
        """Envia um e-mail de texto.

        Raises:
            IntegrationError: SMTP não configurado ou falha no envio.
        """
        s = self._settings
        if not s.smtp_host:
            raise IntegrationError("SMTP não configurado — defina SMTP_HOST no .env")

        msg = EmailMessage()
        msg["From"] = s.smtp_from or s.smtp_user
        msg["To"] = to
        msg["Subject"] = subject
        msg.set_content(body)

        def _send() -> None:
            with smtplib.SMTP(s.smtp_host, s.smtp_port) as smtp:
                if s.smtp_user and s.smtp_password:
                    smtp.starttls()
                    smtp.login(s.smtp_user, s.smtp_password)
                smtp.send_message(msg)

        try:
            await asyncio.to_thread(_send)
        except Exception as exc:  # noqa: BLE001 - fronteira SMTP
            raise IntegrationError(f"Falha no envio de e-mail: {exc}") from exc
        _log.info("notify.email_sent", to=to, subject=subject)


class Notifier:
    """Orquestra os canais com resiliência (um canal não derruba o outro).

    Args:
        whatsapp: Canal WhatsApp. Default: novo :class:`WhatsAppChannel`.
        email: Canal e-mail. Default: novo :class:`EmailChannel`.
    """

    def __init__(
        self,
        whatsapp: WhatsAppChannel | None = None,
        email: EmailChannel | None = None,
        settings: Settings | None = None,
    ) -> None:
        self._whatsapp = whatsapp or WhatsAppChannel(settings=settings)
        self._email = email or EmailChannel(settings=settings)

    async def whatsapp(self, to: str, text: str) -> None:
        """Envia mensagem WhatsApp (propaga :class:`IntegrationError`)."""
        await self._whatsapp.send(to, text)

    async def email(self, to: str, subject: str, body: str) -> None:
        """Envia e-mail (propaga :class:`IntegrationError`)."""
        await self._email.send(to, subject, body)

    async def notify(
        self,
        *,
        subject: str,
        body: str,
        email_to: str | None = None,
        whatsapp_to: str | None = None,
    ) -> dict[str, str]:
        """Notifica pelos canais com destinatário informado, sem propagar erro.

        Returns:
            Status por canal: ``sent``, ``skipped`` ou ``failed: <motivo>``.
        """
        statuses: dict[str, str] = {"email": "skipped", "whatsapp": "skipped"}
        if email_to:
            try:
                await self._email.send(email_to, subject, body)
                statuses["email"] = "sent"
            except Exception as exc:  # noqa: BLE001 - canal não derruba o fluxo
                _log.warning("notify.email_failed", to=email_to, error=str(exc))
                statuses["email"] = f"failed: {exc}"
        if whatsapp_to:
            try:
                await self._whatsapp.send(whatsapp_to, f"{subject}\n\n{body}")
                statuses["whatsapp"] = "sent"
            except Exception as exc:  # noqa: BLE001 - canal não derruba o fluxo
                _log.warning("notify.whatsapp_failed", to=whatsapp_to, error=str(exc))
                statuses["whatsapp"] = f"failed: {exc}"
        return statuses


def inbox_notifier(notifier: Notifier):
    """Adapta o :class:`Notifier` ao callback da agentic-inbox.

    Lê o contato de ``request.payload["notify"]`` (chaves ``email`` e/ou
    ``whatsapp``). Sem contato, não faz nada. NUNCA levanta exceção — a
    notificação é efeito colateral da ação, não pré-condição.
    """

    async def _notify(request: ApprovalRequest, result: object) -> None:
        contact = request.payload.get("notify") or {}
        email_to = contact.get("email")
        whatsapp_to = contact.get("whatsapp")
        if not email_to and not whatsapp_to:
            return
        await notifier.notify(
            subject=f"CARINA — ação '{request.action}' executada",
            body=(
                f"A ação '{request.action}' do agente {request.agent} foi executada "
                f"para o cliente {request.client_id}.\nResultado: {result}"
            ),
            email_to=email_to,
            whatsapp_to=whatsapp_to,
        )

    return _notify
