"""Testes das notificações (WhatsApp mockado via MockTransport; SMTP fake)."""

from __future__ import annotations

import smtplib
from typing import Any

import httpx
import pytest

from carina.config.settings import Settings
from carina.inbox.models import ApprovalRequest, RiskClass
from carina.inbox.service import InboxService
from carina.integrations.notify import (
    EmailChannel,
    Notifier,
    WhatsAppChannel,
    inbox_notifier,
)
from carina.utils.errors import IntegrationError

_SETTINGS = Settings(
    CARINA_ENV="test",
    WHATSAPP_TOKEN="wa-token",
    WHATSAPP_PHONE_NUMBER_ID="5511999",
    SMTP_HOST="smtp.test",
    SMTP_USER="carina@test",
    SMTP_PASSWORD="s3nha",
    SMTP_FROM="noreply@carina.test",
)


# ── WhatsAppChannel ──────────────────────────────────────────────────────────


class _FakeMeta:
    def __init__(self, status: int = 200) -> None:
        self.status = status
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(self.status, json={"messages": [{"id": "wamid.1"}]})


def _wa(fake: _FakeMeta, settings: Settings = _SETTINGS) -> WhatsAppChannel:
    return WhatsAppChannel(
        settings=settings, http=httpx.AsyncClient(transport=httpx.MockTransport(fake))
    )


async def test_whatsapp_envia_com_token_e_numero():
    fake = _FakeMeta()
    await _wa(fake).send("+5511988887777", "Olá!")

    (req,) = fake.requests
    assert "/5511999/messages" in str(req.url.path)
    assert req.headers["Authorization"] == "Bearer wa-token"
    import json

    payload = json.loads(req.content)
    assert payload["to"] == "+5511988887777"
    assert payload["text"]["body"] == "Olá!"


async def test_whatsapp_sem_credenciais_falha_explicito():
    channel = WhatsAppChannel(
        settings=Settings(CARINA_ENV="test"),
        http=httpx.AsyncClient(transport=httpx.MockTransport(_FakeMeta())),
    )
    with pytest.raises(IntegrationError, match="WHATSAPP_TOKEN"):
        await channel.send("+5511988887777", "x")


async def test_whatsapp_http_erro_vira_integration_error():
    with pytest.raises(IntegrationError, match="HTTP 500"):
        await _wa(_FakeMeta(status=500)).send("+5511988887777", "x")


# ── EmailChannel ─────────────────────────────────────────────────────────────


class _FakeSMTP:
    """Substitui smtplib.SMTP registrando a interação."""

    instances: list["_FakeSMTP"] = []

    def __init__(self, host: str, port: int) -> None:
        self.host, self.port = host, port
        self.tls = False
        self.login_args: tuple[str, str] | None = None
        self.sent: list[Any] = []
        _FakeSMTP.instances.append(self)

    def __enter__(self) -> "_FakeSMTP":
        return self

    def __exit__(self, *args: Any) -> None:
        return None

    def starttls(self) -> None:
        self.tls = True

    def login(self, user: str, password: str) -> None:
        self.login_args = (user, password)

    def send_message(self, msg: Any) -> None:
        self.sent.append(msg)


@pytest.fixture
def fake_smtp(monkeypatch: pytest.MonkeyPatch) -> type[_FakeSMTP]:
    _FakeSMTP.instances = []
    monkeypatch.setattr(smtplib, "SMTP", _FakeSMTP)
    return _FakeSMTP


async def test_email_envia_com_starttls_e_login(fake_smtp: type[_FakeSMTP]):
    await EmailChannel(settings=_SETTINGS).send("cliente@ex.com", "Assunto", "Corpo")

    (smtp,) = fake_smtp.instances
    assert (smtp.host, smtp.port) == ("smtp.test", 587)
    assert smtp.tls is True
    assert smtp.login_args == ("carina@test", "s3nha")
    (msg,) = smtp.sent
    assert msg["To"] == "cliente@ex.com"
    assert msg["From"] == "noreply@carina.test"
    assert msg["Subject"] == "Assunto"


async def test_email_sem_smtp_host_falha_explicito():
    with pytest.raises(IntegrationError, match="SMTP_HOST"):
        await EmailChannel(settings=Settings(CARINA_ENV="test")).send("a@b.c", "s", "b")


# ── Notifier (resiliência multi-canal) ───────────────────────────────────────


class _BoomWhatsApp(WhatsAppChannel):
    async def send(self, to: str, text: str) -> None:
        raise IntegrationError("provedor fora do ar")


async def test_notify_um_canal_falhando_nao_derruba_o_outro(fake_smtp: type[_FakeSMTP]):
    notifier = Notifier(whatsapp=_BoomWhatsApp(settings=_SETTINGS), email=EmailChannel(_SETTINGS))
    statuses = await notifier.notify(
        subject="Aviso",
        body="corpo",
        email_to="cliente@ex.com",
        whatsapp_to="+5511988887777",
    )
    assert statuses["email"] == "sent"
    assert statuses["whatsapp"].startswith("failed:")


async def test_notify_sem_destinatario_pula_canal(fake_smtp: type[_FakeSMTP]):
    notifier = Notifier(whatsapp=_wa(_FakeMeta()), email=EmailChannel(_SETTINGS))
    statuses = await notifier.notify(subject="s", body="b", email_to="cliente@ex.com")
    assert statuses == {"email": "sent", "whatsapp": "skipped"}


# ── Integração com a agentic-inbox ───────────────────────────────────────────


async def test_acao_reversivel_executa_e_notifica(fake_smtp: type[_FakeSMTP]):
    notifier = Notifier(whatsapp=_wa(_FakeMeta()), email=EmailChannel(_SETTINGS))
    inbox = InboxService(notifier=inbox_notifier(notifier))

    async def _recategorizar(payload: dict) -> str:
        return "recategorizado"

    inbox.register_executor("recategorize", _recategorizar)
    request = ApprovalRequest.create(
        client_id="acme__c1",
        agent="Categorizer",
        action="recategorize",
        risk=RiskClass.REVERSIBLE,
        payload={"notify": {"email": "cliente@ex.com"}},
    )
    outcome = await inbox.submit(request)

    assert outcome["status"] == "executed_and_notified"
    (smtp,) = fake_smtp.instances
    (msg,) = smtp.sent
    assert "recategorize" in msg["Subject"]


async def test_falha_de_notificacao_nao_derruba_a_acao():
    # WhatsApp configurado mas fora do ar; sem e-mail. A ação executa mesmo assim.
    notifier = Notifier(whatsapp=_BoomWhatsApp(settings=_SETTINGS), email=EmailChannel(_SETTINGS))
    inbox = InboxService(notifier=inbox_notifier(notifier))

    async def _ok(payload: dict) -> str:
        return "ok"

    inbox.register_executor("recategorize", _ok)
    request = ApprovalRequest.create(
        client_id="acme__c1",
        agent="Categorizer",
        action="recategorize",
        risk=RiskClass.REVERSIBLE,
        payload={"notify": {"whatsapp": "+5511988887777"}},
    )
    outcome = await inbox.submit(request)
    assert outcome["status"] == "executed_and_notified"
    assert outcome["result"] == "ok"


async def test_sem_contato_no_payload_nao_notifica(fake_smtp: type[_FakeSMTP]):
    notifier = Notifier(whatsapp=_wa(_FakeMeta()), email=EmailChannel(_SETTINGS))
    callback = inbox_notifier(notifier)
    request = ApprovalRequest.create(
        client_id="acme__c1", agent="X", action="a", risk=RiskClass.REVERSIBLE, payload={}
    )
    await callback(request, "resultado")
    assert fake_smtp.instances == []
