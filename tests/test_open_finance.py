"""Testes da integração Open Finance (Pluggy mockado via httpx.MockTransport)."""

from __future__ import annotations

from datetime import date

import httpx
import pytest
from fastapi.testclient import TestClient

from carina.api.app import app
from carina.b2b.tenants import ApiKeyStore
from carina.config.settings import Settings
from carina.integrations.open_finance import (
    InMemoryConnectionRegistry,
    OpenFinanceClient,
    OpenFinanceProvider,
    PluggyProvider,
    Position,
    Transaction,
)
from carina.utils.errors import IntegrationError

_SETTINGS = Settings(
    OPEN_FINANCE_CLIENT_ID="cid",
    OPEN_FINANCE_CLIENT_SECRET="csecret",
    CARINA_ENV="test",
)

_ACCOUNTS = {
    "results": [
        {
            "id": "acc-1",
            "type": "BANK",
            "name": "Banco Alfa",
            "marketingName": "Conta Corrente",
            "balance": 1234.56,
            "currencyCode": "BRL",
        },
        {"id": "acc-2", "type": "CREDIT", "name": "Cartão Alfa", "balance": -200.0},
    ]
}

_INVESTMENTS = {
    "results": [
        {
            "id": "inv-1",
            "name": "Tesouro Selic 2029",
            "code": "LFT",
            "quantity": 10.5,
            "balance": 50000.0,
            "issuer": "Tesouro Nacional",
        }
    ]
}


def _transactions_page(page: int) -> dict:
    return {
        "results": [
            {
                "id": f"tx-{page}",
                "date": "2026-06-01T12:00:00Z",
                "description": f"Compra {page}",
                "amount": -100.0 * page,
                "category": "Mercado",
            }
        ],
        "page": page,
        "totalPages": 2,
    }


class _FakePluggy:
    """Handler do MockTransport simulando a API do Pluggy."""

    def __init__(self) -> None:
        self.auth_calls = 0
        self.fail_next_with_401 = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth":
            self.auth_calls += 1
            return httpx.Response(200, json={"apiKey": f"key-{self.auth_calls}"})

        if not request.headers.get("X-API-KEY"):
            return httpx.Response(401)
        if self.fail_next_with_401:
            self.fail_next_with_401 = False
            return httpx.Response(401)

        if request.url.path == "/accounts":
            return httpx.Response(200, json=_ACCOUNTS)
        if request.url.path == "/investments":
            return httpx.Response(200, json=_INVESTMENTS)
        if request.url.path == "/transactions":
            page = int(request.url.params.get("page", "1"))
            return httpx.Response(200, json=_transactions_page(page))
        return httpx.Response(404)


def _provider(fake: _FakePluggy) -> PluggyProvider:
    http = httpx.AsyncClient(transport=httpx.MockTransport(fake))
    return PluggyProvider(settings=_SETTINGS, http=http)


# ── PluggyProvider ───────────────────────────────────────────────────────────


async def test_fetch_positions_normaliza_contas_e_investimentos():
    provider = _provider(_FakePluggy())
    positions = await provider.fetch_positions("item-1")

    by_id = {p.id: p for p in positions}
    # Conta BANK vira posição cash; cartão de crédito NÃO vira posição.
    assert by_id["acc-1"].kind == "cash"
    assert by_id["acc-1"].value == 1234.56
    assert "acc-2" not in by_id
    # Investimento vem com código e quantidade.
    assert by_id["inv-1"].kind == "investment"
    assert by_id["inv-1"].asset_code == "LFT"
    assert by_id["inv-1"].quantity == 10.5


async def test_fetch_transactions_pagina_e_filtra_por_data():
    fake = _FakePluggy()
    provider = _provider(fake)
    txs = await provider.fetch_transactions("item-1", since=date(2026, 5, 1))

    # 2 contas × 2 páginas = 4 transações.
    assert len(txs) == 4
    assert {t.id for t in txs} == {"tx-1", "tx-2"}  # ids por página
    assert all(t.currency == "BRL" for t in txs)


async def test_reautentica_em_401_e_segue():
    fake = _FakePluggy()
    provider = _provider(fake)
    await provider.fetch_positions("item-1")
    assert fake.auth_calls == 1

    fake.fail_next_with_401 = True
    positions = await provider.fetch_positions("item-1")
    assert positions  # recuperou após re-auth
    assert fake.auth_calls == 2


async def test_sem_credenciais_falha_explicito():
    provider = PluggyProvider(
        settings=Settings(CARINA_ENV="test"),
        http=httpx.AsyncClient(transport=httpx.MockTransport(_FakePluggy())),
    )
    with pytest.raises(IntegrationError, match="OPEN_FINANCE_CLIENT_ID"):
        await provider.fetch_positions("item-1")


# ── Documentos idempotentes ──────────────────────────────────────────────────


def test_to_document_tem_id_estavel_e_fonte():
    pos = Position(id="inv-1", item_id="i", name="LFT", kind="investment", value=1.0)
    doc = pos.to_document()
    assert doc.document_id == "position:inv-1"
    assert doc.metadata["source"] == "open_finance"

    tx = Transaction(
        id="tx-9",
        item_id="i",
        account_id="a",
        date=__import__("datetime").datetime(2026, 6, 1),
        description="Compra",
        amount=-10.0,
    )
    assert tx.to_document().document_id == "transaction:tx-9"


# ── OpenFinanceClient (agregação multi-item) ─────────────────────────────────


class _FlakyProvider(OpenFinanceProvider):
    """item-bom responde; item-ruim explode (instituição fora do ar)."""

    async def fetch_positions(self, item_id: str) -> list[Position]:
        if item_id == "item-ruim":
            raise IntegrationError("instituição indisponível")
        return [Position(id=f"p-{item_id}", item_id=item_id, name="x", kind="cash", value=1.0)]

    async def fetch_transactions(self, item_id: str, since=None) -> list[Transaction]:
        return []


async def test_falha_de_um_item_nao_derruba_a_consolidacao():
    client = OpenFinanceClient(provider=_FlakyProvider(), registry=InMemoryConnectionRegistry())
    await client.registry.add("acme__c1", "item-bom")
    await client.registry.add("acme__c1", "item-ruim")

    positions = await client.fetch_positions("acme__c1")
    assert [p.id for p in positions] == ["p-item-bom"]


async def test_registry_em_memoria():
    reg = InMemoryConnectionRegistry()
    await reg.add("acme__c1", "item-1")
    await reg.add("acme__c1", "item-1")  # idempotente
    await reg.add("warren__c9", "item-2")

    assert await reg.list_items("acme__c1") == ["item-1"]
    assert await reg.list_clients() == ["acme__c1", "warren__c9"]
    assert await reg.remove("acme__c1", "item-1") is True
    assert await reg.remove("acme__c1", "item-1") is False
    assert await reg.list_clients() == ["warren__c9"]


# ── API ──────────────────────────────────────────────────────────────────────

_KEYS = "sk-acme:acme:Acme;sk-warren:warren:Warren"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    key_store = ApiKeyStore(settings=Settings(CARINA_API_KEYS=_KEYS, CARINA_ENV="test"))
    of_client = OpenFinanceClient(provider=_FlakyProvider(), registry=InMemoryConnectionRegistry())
    monkeypatch.setattr("carina.api.auth.get_api_key_store", lambda: key_store)
    monkeypatch.setattr("carina.api.routes.get_open_finance", lambda: of_client)
    with TestClient(app) as c:
        yield c


def _auth(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


def test_api_conexoes_e_posicoes_isoladas_por_tenant(client: TestClient):
    resp = client.post(
        "/api/clients/c1/connections", json={"item_id": "item-bom"}, headers=_auth("sk-acme")
    )
    assert resp.status_code == 201

    listed = client.get("/api/clients/c1/connections", headers=_auth("sk-acme")).json()
    assert listed["item_ids"] == ["item-bom"]
    # Mesmo client_id em outro tenant: namespace separado, lista vazia.
    other = client.get("/api/clients/c1/connections", headers=_auth("sk-warren")).json()
    assert other["item_ids"] == []

    positions = client.get("/api/clients/c1/positions", headers=_auth("sk-acme")).json()
    assert [p["id"] for p in positions["positions"]] == ["p-item-bom"]

    # Remoção: 404 para quem não tem a conexão; 200 para o dono.
    assert (
        client.delete(
            "/api/clients/c1/connections/item-bom", headers=_auth("sk-warren")
        ).status_code
        == 404
    )
    assert (
        client.delete("/api/clients/c1/connections/item-bom", headers=_auth("sk-acme")).status_code
        == 200
    )
