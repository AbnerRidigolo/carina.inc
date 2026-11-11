"""Testes do Data Engine — Camada 1 (brapi/BCB mockados via MockTransport)."""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from carina.api.app import app
from carina.b2b.metering import MeteringService
from carina.b2b.tenants import ApiKeyStore
from carina.config.settings import Settings
from carina.data_engine.market_data import (
    AssetClass,
    BcbProvider,
    BrapiProvider,
    HistoricalBar,
    MacroIndicator,
    MacroProvider,
    MarketDataProvider,
    MarketDataService,
    Quote,
    TTLCache,
    infer_asset_class,
)
from carina.utils.errors import IntegrationError

_SETTINGS = Settings(CARINA_ENV="test", BRAPI_TOKEN="tok-123")


# ── Heurística de classe de ativo ────────────────────────────────────────────


@pytest.mark.parametrize(
    ("symbol", "expected"),
    [
        ("PETR4", AssetClass.STOCK),
        ("VALE3", AssetClass.STOCK),
        ("HGLG11", AssetClass.FUND),
        ("BOVA11", AssetClass.FUND),
        ("AAPL34", AssetClass.BDR),
        ("^BVSP", AssetClass.INDEX),
        ("ABCD99", AssetClass.UNKNOWN),
    ],
)
def test_infer_asset_class(symbol: str, expected: AssetClass):
    assert infer_asset_class(symbol) == expected


# ── BrapiProvider ────────────────────────────────────────────────────────────

_BRAPI_QUOTE = {
    "results": [
        {
            "symbol": "PETR4",
            "shortName": "PETROBRAS PN",
            "regularMarketPrice": 38.42,
            "regularMarketChangePercent": 1.25,
            "regularMarketPreviousClose": 37.95,
            "regularMarketVolume": 51234567,
            "marketCap": 500_000_000_000,
            "currency": "BRL",
        }
    ]
}

_BRAPI_HISTORY = {
    "results": [
        {
            "symbol": "PETR4",
            "historicalDataPrice": [
                {
                    "date": 1717200000,
                    "open": 37.0,
                    "high": 38.0,
                    "low": 36.5,
                    "close": 37.8,
                    "volume": 100,
                },
                {
                    "date": 1717286400,
                    "open": 37.8,
                    "high": 38.5,
                    "low": 37.5,
                    "close": 38.4,
                    "volume": 200,
                },
            ],
        }
    ]
}


class _FakeBrapi:
    def __init__(self) -> None:
        self.calls: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if "range" in request.url.params:
            return httpx.Response(200, json=_BRAPI_HISTORY)
        return httpx.Response(200, json=_BRAPI_QUOTE)


def _brapi(fake: _FakeBrapi) -> BrapiProvider:
    return BrapiProvider(
        settings=_SETTINGS, http=httpx.AsyncClient(transport=httpx.MockTransport(fake))
    )


async def test_brapi_normaliza_cotacao_e_envia_token():
    fake = _FakeBrapi()
    quotes = await _brapi(fake).fetch_quotes(["petr4"])

    assert fake.calls[0].url.params["token"] == "tok-123"
    assert "PETR4" in str(fake.calls[0].url.path)
    (q,) = quotes
    assert q.symbol == "PETR4"
    assert q.asset_class is AssetClass.STOCK
    assert q.price == 38.42
    assert q.change_pct == 1.25
    assert q.market_cap == 500_000_000_000


async def test_brapi_normaliza_historico():
    bars = await _brapi(_FakeBrapi()).fetch_history("PETR4", range_="1mo")
    assert len(bars) == 2
    assert bars[0].close == 37.8
    assert bars[1].date.year >= 2024  # timestamp unix convertido


# ── BcbProvider ──────────────────────────────────────────────────────────────


def _fake_bcb(request: httpx.Request) -> httpx.Response:
    # /dados/serie/bcdata.sgs.{id}/dados/ultimos/1
    series_id = request.url.path.split("bcdata.sgs.")[1].split("/")[0]
    values = {"432": "15.00", "4389": "14.65", "433": "0.32", "1": "5.18"}
    return httpx.Response(200, json=[{"data": "11/06/2026", "valor": values.get(series_id, "0")}])


async def test_bcb_normaliza_macro():
    provider = BcbProvider(
        settings=_SETTINGS, http=httpx.AsyncClient(transport=httpx.MockTransport(_fake_bcb))
    )
    indicators = {i.code: i for i in await provider.fetch_macro()}
    assert indicators["selic"].value == 15.00
    assert indicators["selic"].unit == "% a.a."
    assert indicators["ipca"].value == 0.32
    assert indicators["ptax_usd"].value == 5.18
    assert indicators["cdi"].reference_date == "11/06/2026"


# ── Cache TTL ────────────────────────────────────────────────────────────────


class _Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


class _CountingProvider(MarketDataProvider):
    def __init__(self) -> None:
        self.quote_calls = 0
        self.history_calls = 0

    async def fetch_quotes(self, symbols: list[str]) -> list[Quote]:
        self.quote_calls += 1
        return [Quote(symbol=s, price=1.0) for s in symbols]

    async def fetch_history(self, symbol: str, range_: str = "3mo") -> list[HistoricalBar]:
        self.history_calls += 1
        return []


class _CountingMacro(MacroProvider):
    def __init__(self) -> None:
        self.calls = 0

    async def fetch_macro(self) -> list[MacroIndicator]:
        self.calls += 1
        return [MacroIndicator(code="selic", name="Selic", value=15.0, unit="% a.a.")]


async def test_cache_evita_chamadas_repetidas_e_expira():
    clock = _Clock()
    provider = _CountingProvider()
    svc = MarketDataService(
        provider=provider, macro_provider=_CountingMacro(), cache=TTLCache(now_fn=clock)
    )

    await svc.quotes(["PETR4", "VALE3"])
    await svc.quotes(["PETR4", "VALE3"])  # tudo em cache
    assert provider.quote_calls == 1

    # Símbolo novo: busca SÓ o que falta.
    await svc.quotes(["PETR4", "HGLG11"])
    assert provider.quote_calls == 2

    # Expirou (60s) → busca de novo.
    clock.t += 61
    await svc.quotes(["PETR4"])
    assert provider.quote_calls == 3


async def test_cache_macro_uma_hora():
    clock = _Clock()
    macro = _CountingMacro()
    svc = MarketDataService(
        provider=_CountingProvider(), macro_provider=macro, cache=TTLCache(now_fn=clock)
    )
    await svc.macro()
    await svc.macro()
    assert macro.calls == 1
    clock.t += 3601
    await svc.macro()
    assert macro.calls == 2


# ── API ──────────────────────────────────────────────────────────────────────

_KEYS = "sk-acme:acme:Acme"


class _BoomProvider(MarketDataProvider):
    async def fetch_quotes(self, symbols: list[str]) -> list[Quote]:
        raise IntegrationError("fonte fora do ar")

    async def fetch_history(self, symbol: str, range_: str = "3mo") -> list[HistoricalBar]:
        raise IntegrationError("fonte fora do ar")


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    key_store = ApiKeyStore(settings=Settings(CARINA_API_KEYS=_KEYS, CARINA_ENV="test"))
    metering = MeteringService()
    svc = MarketDataService(provider=_CountingProvider(), macro_provider=_CountingMacro())
    monkeypatch.setattr("carina.api.auth.get_api_key_store", lambda: key_store)
    monkeypatch.setattr("carina.api.routes.get_metering", lambda: metering)
    monkeypatch.setattr("carina.api.routes.get_market_data", lambda: svc)
    with TestClient(app) as c:
        yield c


def _auth(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


def test_api_quotes_exige_auth_e_mede_data_query(client: TestClient):
    assert client.get("/api/market/quotes?symbols=PETR4").status_code == 401

    resp = client.get("/api/market/quotes?symbols=PETR4,VALE3", headers=_auth("sk-acme"))
    assert resp.status_code == 200
    body = resp.json()
    assert [q["symbol"] for q in body["quotes"]] == ["PETR4", "VALE3"]
    assert body["usage"]["work_type"] == "data_query"
    assert body["usage"]["price_brl"] == 0.05

    macro = client.get("/api/market/macro", headers=_auth("sk-acme")).json()
    assert macro["indicators"][0]["code"] == "selic"

    usage = client.get("/api/usage", headers=_auth("sk-acme")).json()
    assert usage["by_work_type"]["data_query"]["count"] == 2


def test_api_quotes_sem_simbolos_retorna_422(client: TestClient):
    assert client.get("/api/market/quotes?symbols=,", headers=_auth("sk-acme")).status_code == 422


def test_api_fonte_fora_do_ar_retorna_502(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    svc = MarketDataService(provider=_BoomProvider(), macro_provider=_CountingMacro())
    monkeypatch.setattr("carina.api.routes.get_market_data", lambda: svc)
    resp = client.get("/api/market/quotes?symbols=PETR4", headers=_auth("sk-acme"))
    assert resp.status_code == 502
