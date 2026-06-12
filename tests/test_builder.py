"""Testes da Builder Layer — especificação, backtest e API."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from carina.api.app import app
from carina.b2b.metering import MeteringService
from carina.b2b.tenants import ApiKeyStore
from carina.builder.backtest import run_backtest
from carina.builder.strategies import BuilderService, StrategyKind, StrategySpec
from carina.config.settings import Settings
from carina.data_engine.market_data import HistoricalBar, MarketDataService
from carina.utils.errors import BuilderError


def _bars(closes: list[float]) -> list[HistoricalBar]:
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        HistoricalBar(date=start + timedelta(days=i), open=c, high=c, low=c, close=c, volume=100)
        for i, c in enumerate(closes)
    ]


# ── Especificação ────────────────────────────────────────────────────────────


def test_spec_sma_exige_fast_menor_que_slow():
    with pytest.raises(ValidationError, match="fast < slow"):
        StrategySpec(kind=StrategyKind.SMA_CROSS, symbol="PETR4", fast=50, slow=10)
    spec = StrategySpec(kind=StrategyKind.SMA_CROSS, symbol="PETR4", fast=3, slow=5)
    assert spec.fast < spec.slow


# ── Backtest ─────────────────────────────────────────────────────────────────


def test_buy_hold_em_alta_monotonica():
    result = run_backtest(kind="buy_hold", symbol="PETR4", bars=_bars([100, 110, 121]))
    assert result.total_return_pct == pytest.approx(21.0)
    assert result.max_drawdown_pct == 0.0
    assert result.trades == 1  # entrada única
    assert result.final_equity == pytest.approx(121.0)
    assert result.equity_curve[0] == 100.0


def test_buy_hold_mede_drawdown():
    result = run_backtest(kind="buy_hold", symbol="PETR4", bars=_bars([100, 120, 90, 100]))
    # Pico em 120 → vale em 90: drawdown de 25%.
    assert result.max_drawdown_pct == pytest.approx(25.0)


def test_sma_cross_sai_da_posicao_na_virada():
    # Sobe e desaba: a média rápida cruza para baixo e a estratégia vai a caixa.
    closes = [100, 102, 104, 106, 108, 110, 70, 50, 40, 30, 20, 10]
    result = run_backtest(kind="sma_cross", symbol="PETR4", bars=_bars(closes), fast=2, slow=4)
    buy_hold = run_backtest(kind="buy_hold", symbol="PETR4", bars=_bars(closes))
    assert result.trades >= 2  # entrou e saiu
    # Em caixa durante parte da queda → perde menos que segurar até o fim.
    assert result.final_equity > buy_hold.final_equity


def test_sem_lookahead_no_primeiro_dia_de_sinal():
    # Sinal só nasce na barra t; a posição vale a partir de t+1. Com 5 barras e
    # fast=2/slow=4, o primeiro sinal possível é na 4ª barra → único retorno
    # capturável é o da 5ª.
    closes = [100, 100, 100, 100, 150]
    result = run_backtest(kind="sma_cross", symbol="X", bars=_bars(closes), fast=2, slow=4)
    assert result.total_return_pct == 0.0  # sinal de t=4 só valeria em t=5 (não existe)


def test_historico_insuficiente_falha_explicito():
    with pytest.raises(BuilderError, match="insuficiente"):
        run_backtest(kind="sma_cross", symbol="X", bars=_bars([1, 2, 3]), fast=2, slow=10)


# ── BuilderService ───────────────────────────────────────────────────────────


class _FakeMarketData(MarketDataService):
    def __init__(self, closes: list[float]) -> None:
        self._closes = closes

    async def history(self, symbol: str, range_: str = "3mo"):
        return _bars(self._closes)


async def test_service_cria_lista_e_backtesta_isolado_por_tenant():
    svc = BuilderService(market_data=_FakeMarketData([100, 110, 121]))
    strategy = await svc.create(
        tenant_id="acme",
        name="Carrega PETR4",
        spec=StrategySpec(kind=StrategyKind.BUY_HOLD, symbol="PETR4"),
    )
    assert [s.id for s in await svc.list_for_tenant("acme")] == [strategy.id]
    assert await svc.list_for_tenant("warren") == []

    result = await svc.backtest(strategy)
    assert result.total_return_pct == pytest.approx(21.0)


# ── API ──────────────────────────────────────────────────────────────────────

_KEYS = "sk-acme:acme:Acme;sk-warren:warren:Warren"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    key_store = ApiKeyStore(settings=Settings(CARINA_API_KEYS=_KEYS, CARINA_ENV="test"))
    metering = MeteringService()
    builder = BuilderService(market_data=_FakeMarketData([100, 110, 121]))
    monkeypatch.setattr("carina.api.auth.get_api_key_store", lambda: key_store)
    monkeypatch.setattr("carina.api.routes.get_metering", lambda: metering)
    monkeypatch.setattr("carina.api.routes.get_builder", lambda: builder)
    with TestClient(app) as c:
        yield c


def _auth(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


def test_api_cria_backtesta_e_cobra(client: TestClient):
    assert client.get("/api/builder/strategies").status_code == 401

    resp = client.post(
        "/api/builder/strategies",
        json={"name": "Carrega PETR4", "spec": {"kind": "buy_hold", "symbol": "PETR4"}},
        headers=_auth("sk-acme"),
    )
    assert resp.status_code == 201
    strategy = resp.json()

    listed = client.get("/api/builder/strategies", headers=_auth("sk-acme")).json()
    assert [s["id"] for s in listed["strategies"]] == [strategy["id"]]
    assert client.get("/api/builder/strategies", headers=_auth("sk-warren")).json() == {
        "strategies": []
    }

    # Outro tenant não backtesta (404, sem vazar existência).
    assert (
        client.post(
            f"/api/builder/strategies/{strategy['id']}/backtest", headers=_auth("sk-warren")
        ).status_code
        == 404
    )

    run = client.post(
        f"/api/builder/strategies/{strategy['id']}/backtest", headers=_auth("sk-acme")
    )
    assert run.status_code == 200
    body = run.json()
    assert body["total_return_pct"] == pytest.approx(21.0)
    assert body["usage"] == {"work_type": "backtest", "price_brl": 7.50}

    usage = client.get("/api/usage", headers=_auth("sk-acme")).json()
    assert usage["by_work_type"]["backtest"]["count"] == 1


def test_api_spec_invalida_retorna_422(client: TestClient):
    resp = client.post(
        "/api/builder/strategies",
        json={
            "name": "x",
            "spec": {"kind": "sma_cross", "symbol": "PETR4", "fast": 50, "slow": 10},
        },
        headers=_auth("sk-acme"),
    )
    assert resp.status_code == 422


def test_api_historico_insuficiente_retorna_422(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    builder = BuilderService(market_data=_FakeMarketData([100, 110]))
    monkeypatch.setattr("carina.api.routes.get_builder", lambda: builder)

    created = client.post(
        "/api/builder/strategies",
        json={"name": "x", "spec": {"kind": "sma_cross", "symbol": "PETR4", "fast": 3, "slow": 5}},
        headers=_auth("sk-acme"),
    ).json()
    resp = client.post(
        f"/api/builder/strategies/{created['id']}/backtest", headers=_auth("sk-acme")
    )
    assert resp.status_code == 422
