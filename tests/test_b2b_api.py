"""Testes da API B2B ponta a ponta (TestClient, orquestrador mockado).

Cobre autenticação por chave, isolamento multi-tenant, metering por resolução
e flags do Watchtower na resposta do ``/chat``.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from carina.api.app import app
from carina.b2b.metering import MeteringService
from carina.b2b.tenants import ApiKeyStore
from carina.b2b.watchtower import Watchtower
from carina.config.settings import Settings
from carina.inbox.models import ApprovalRequest, RiskClass
from carina.inbox.service import InboxService

_KEYS = "sk-acme:acme:Acme Fintech;sk-warren:warren:Warren"


class FakeOrchestrator:
    """Orquestrador fake: registra o client_id recebido e devolve saída fixa."""

    seen_client_ids: list[str] = []

    def __init__(self, client_id: str, response: str = "Tudo certo.") -> None:
        self.client_id = client_id
        self._response = response

    async def handle(self, query: str) -> dict[str, Any]:
        FakeOrchestrator.seen_client_ids.append(self.client_id)
        return {
            "plan": {"complexity": "média", "agents": ["insight"], "rationale": "teste"},
            "results": {"insight": self._response},
        }


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    """TestClient com chaves de teste e serviços B2B frescos por teste.

    Usado como context manager para que todas as requisições compartilhem o
    mesmo event loop (os locks asyncio dos stores em memória são bound ao loop).
    """
    FakeOrchestrator.seen_client_ids = []
    store = ApiKeyStore(settings=Settings(CARINA_API_KEYS=_KEYS, CARINA_ENV="test"))
    metering = MeteringService()
    watchtower = Watchtower()
    inbox = InboxService()

    monkeypatch.setattr("carina.api.auth.get_api_key_store", lambda: store)
    monkeypatch.setattr("carina.api.routes.get_orchestrator", FakeOrchestrator)
    monkeypatch.setattr("carina.api.routes.get_metering", lambda: metering)
    monkeypatch.setattr("carina.api.routes.get_watchtower", lambda: watchtower)
    monkeypatch.setattr("carina.api.routes.get_inbox", lambda: inbox)
    with TestClient(app) as c:
        yield c


def _auth(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


def test_health_e_aberto(client: TestClient):
    assert client.get("/api/health").status_code == 200


def test_chat_sem_chave_retorna_401(client: TestClient):
    resp = client.post("/api/chat", json={"client_id": "c1", "message": "oi"})
    assert resp.status_code == 401


def test_chat_com_chave_invalida_retorna_401(client: TestClient):
    resp = client.post(
        "/api/chat",
        json={"client_id": "c1", "message": "oi"},
        headers=_auth("sk-errada"),
    )
    assert resp.status_code == 401


def test_chat_escopa_client_id_e_retorna_usage_e_compliance(client: TestClient):
    resp = client.post(
        "/api/chat",
        json={"client_id": "c1", "message": "como está meu portfólio?"},
        headers=_auth("sk-acme"),
    )
    assert resp.status_code == 200
    body = resp.json()

    # Isolamento: o orquestrador recebe o id já no namespace do tenant.
    assert FakeOrchestrator.seen_client_ids == ["acme__c1"]

    assert body["usage"]["work_type"] == "analysis"
    assert body["usage"]["price_brl"] == 7.50
    assert body["compliance"]["flags"] == []
    assert body["compliance"]["audit_id"]


def test_client_id_com_separador_retorna_422(client: TestClient):
    # '__' quebraria o namespace do tenant — rejeitado na fronteira HTTP.
    resp = client.post(
        "/api/chat",
        json={"client_id": "staging__victim", "message": "oi"},
        headers=_auth("sk-acme"),
    )
    assert resp.status_code == 422
    assert client.get("/api/clients/a__b/inbox", headers=_auth("sk-acme")).status_code == 422


def test_chat_aceita_x_api_key(client: TestClient):
    resp = client.post(
        "/api/chat",
        json={"client_id": "c1", "message": "oi"},
        headers={"X-API-Key": "sk-acme"},
    )
    assert resp.status_code == 200


def test_usage_acumula_e_e_isolado_por_tenant(client: TestClient):
    for _ in range(2):
        client.post(
            "/api/chat",
            json={"client_id": "c1", "message": "oi"},
            headers=_auth("sk-acme"),
        )

    acme = client.get("/api/usage", headers=_auth("sk-acme")).json()
    assert acme["resolutions"] == 2
    assert acme["total_brl"] == 15.00

    warren = client.get("/api/usage", headers=_auth("sk-warren")).json()
    assert warren["resolutions"] == 0


def test_audit_registra_flags_de_compliance(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    def _violador(client_id: str) -> FakeOrchestrator:
        return FakeOrchestrator(client_id, response="Recomendo comprar PETR4, lucro garantido.")

    monkeypatch.setattr("carina.api.routes.get_orchestrator", _violador)

    resp = client.post(
        "/api/chat",
        json={"client_id": "c1", "message": "o que faço?"},
        headers=_auth("sk-acme"),
    )
    codes = {f["code"] for f in resp.json()["compliance"]["flags"]}
    assert "cvm.unauthorized_recommendation" in codes
    assert "suitability.certainty_claim" in codes

    trail = client.get("/api/audit", headers=_auth("sk-acme")).json()["events"]
    assert len(trail) == 1
    assert {f["code"] for f in trail[0]["flags"]} >= codes


async def _seed_pending(inbox: InboxService, client_id: str) -> str:
    request = ApprovalRequest.create(
        client_id=client_id, agent="executor", action="place_trade", risk=RiskClass.IRREVERSIBLE
    )
    await inbox.submit(request)
    return request.id


def test_inbox_e_isolada_por_tenant(client: TestClient):
    # routes.get_inbox foi trocado por um lambda no fixture; recupera o serviço
    # e semeia uma pendência no MESMO loop do TestClient (via portal).
    from carina.api import routes

    inbox = routes.get_inbox()
    request_id = client.portal.call(_seed_pending, inbox, "acme__c1")

    # O dono vê e decide.
    pending = client.get("/api/clients/c1/inbox", headers=_auth("sk-acme")).json()["pending"]
    assert [p["id"] for p in pending] == [request_id]

    # Outro tenant não vê (lista vazia) nem decide (404, sem vazar existência).
    other = client.get("/api/clients/c1/inbox", headers=_auth("sk-warren")).json()["pending"]
    assert other == []
    resp = client.post(
        f"/api/inbox/{request_id}/decision",
        json={"approved": False, "decided_by": "ops@warren"},
        headers=_auth("sk-warren"),
    )
    assert resp.status_code == 404

    resp = client.post(
        f"/api/inbox/{request_id}/decision",
        json={"approved": False, "decided_by": "ops@acme"},
        headers=_auth("sk-acme"),
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "rejected"
