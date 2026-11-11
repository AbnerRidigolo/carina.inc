"""Testes de rate limiting (RPM) e quota mensal por tenant."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from carina.api.app import app
from carina.b2b.metering import MeteringService
from carina.b2b.ratelimit import LimitsConfig, RateLimiter
from carina.b2b.tenants import ApiKeyStore
from carina.b2b.watchtower import Watchtower
from carina.config.settings import Settings


def _settings(limits: str = "", rpm: int = 60, quota: int = 0) -> Settings:
    return Settings(
        CARINA_TENANT_LIMITS=limits,
        CARINA_DEFAULT_RPM=rpm,
        CARINA_DEFAULT_MONTHLY_QUOTA=quota,
        CARINA_ENV="test",
    )


# ── LimitsConfig ─────────────────────────────────────────────────────────────


def test_limits_default_e_override():
    cfg = LimitsConfig(settings=_settings(limits="acme:120:5000;warren:30", rpm=60, quota=0))
    acme = cfg.for_tenant("acme")
    assert (acme.rpm, acme.monthly_resolutions) == (120, 5000)
    # Override só de RPM herda a quota default.
    assert cfg.for_tenant("warren").rpm == 30
    assert cfg.for_tenant("warren").monthly_resolutions == 0
    # Tenant sem override usa os defaults.
    assert cfg.for_tenant("outro").rpm == 60


def test_limits_entrada_invalida_e_ignorada():
    cfg = LimitsConfig(settings=_settings(limits="quebrado;acme:abc;ok:10"))
    assert cfg.for_tenant("ok").rpm == 10
    assert cfg.for_tenant("acme").rpm == 60  # entrada inválida → default


# ── RateLimiter ──────────────────────────────────────────────────────────────


class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


async def test_rate_limiter_bloqueia_e_desliza_a_janela():
    clock = FakeClock()
    limiter = RateLimiter(now_fn=clock)

    assert await limiter.try_acquire("acme", rpm=2)
    assert await limiter.try_acquire("acme", rpm=2)
    assert not await limiter.try_acquire("acme", rpm=2)
    assert await limiter.retry_after("acme") >= 1

    # Outro tenant tem janela própria.
    assert await limiter.try_acquire("warren", rpm=2)

    # Passada a janela de 60s, libera de novo.
    clock.t += 61
    assert await limiter.try_acquire("acme", rpm=2)


# ── Quota mensal ─────────────────────────────────────────────────────────────


async def test_resolutions_this_month_conta_apenas_o_tenant():
    metering = MeteringService()
    await metering.record_resolution(tenant_id="acme", client_id="acme__c1", agents=[])
    await metering.record_resolution(tenant_id="warren", client_id="warren__c1", agents=[])
    assert await metering.resolutions_this_month("acme") == 1


# ── API ──────────────────────────────────────────────────────────────────────

_KEYS = "sk-acme:acme:Acme;sk-warren:warren:Warren"


class FakeOrchestrator:
    def __init__(self, client_id: str) -> None:
        self.client_id = client_id

    async def handle(self, query: str):
        return {"plan": {"complexity": "simples", "agents": []}, "results": {"navigator": "oi"}}


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    """API com acme limitado a 3 RPM (quota livre) e warren a quota mensal 2."""
    key_store = ApiKeyStore(settings=Settings(CARINA_API_KEYS=_KEYS, CARINA_ENV="test"))
    limits = LimitsConfig(settings=_settings(limits="acme:3:0;warren:100:2", rpm=100, quota=0))
    limiter = RateLimiter()
    metering = MeteringService()
    watchtower = Watchtower()

    monkeypatch.setattr("carina.api.auth.get_api_key_store", lambda: key_store)
    monkeypatch.setattr("carina.api.auth.get_limits_config", lambda: limits)
    monkeypatch.setattr("carina.api.auth.get_rate_limiter", lambda: limiter)
    monkeypatch.setattr("carina.api.auth.get_metering", lambda: metering)
    monkeypatch.setattr("carina.api.routes.get_orchestrator", FakeOrchestrator)
    monkeypatch.setattr("carina.api.routes.get_metering", lambda: metering)
    monkeypatch.setattr("carina.api.routes.get_watchtower", lambda: watchtower)
    with TestClient(app) as c:
        yield c


def _auth(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


def test_api_rpm_excedido_retorna_429_com_retry_after(client: TestClient):
    for _ in range(3):
        assert client.get("/api/usage", headers=_auth("sk-acme")).status_code == 200
    resp = client.get("/api/usage", headers=_auth("sk-acme"))
    assert resp.status_code == 429
    assert "Retry-After" in resp.headers
    # O limite é por tenant: warren continua passando.
    assert client.get("/api/usage", headers=_auth("sk-warren")).status_code == 200


def test_api_quota_mensal_bloqueia_chat_mas_nao_leitura(client: TestClient):
    body = {"client_id": "c1", "message": "oi"}
    assert client.post("/api/chat", json=body, headers=_auth("sk-warren")).status_code == 200
    assert client.post("/api/chat", json=body, headers=_auth("sk-warren")).status_code == 200

    # Quota (2) esgotada: trabalho novo bloqueia…
    resp = client.post("/api/chat", json=body, headers=_auth("sk-warren"))
    assert resp.status_code == 429
    assert "Quota" in resp.json()["detail"]

    # …mas o tenant ainda enxerga a própria conta (sem consumir quota).
    usage = client.get("/api/usage", headers=_auth("sk-warren"))
    assert usage.status_code == 200
    assert usage.json()["resolutions"] == 2
