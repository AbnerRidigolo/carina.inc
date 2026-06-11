"""Testes dos AOPs — agenda, compilação heurística, execução e API."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from carina.api.app import app
from carina.b2b.aops import (
    AOPService,
    Frequency,
    Schedule,
    _heuristic_compile,
)
from carina.b2b.metering import MeteringService
from carina.b2b.tenants import ApiKeyStore
from carina.b2b.watchtower import Watchtower
from carina.config.settings import Settings
from carina.utils.errors import AOPError

_TEXT_SEXTA = (
    "Toda sexta, monitore as carteiras premium, gere análise de portfólio "
    "e identifique oportunidades tributárias para cada cliente."
)


def _utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=timezone.utc)


# ── Agenda ───────────────────────────────────────────────────────────────────


def test_schedule_daily_is_due():
    sched = Schedule(frequency=Frequency.DAILY, hour=11)
    now = _utc(2026, 6, 11, 12, 0)
    assert sched.is_due(now, last_run=None)
    assert not sched.is_due(now, last_run=_utc(2026, 6, 11, 11, 30))
    assert sched.is_due(now, last_run=_utc(2026, 6, 10, 11, 30))


def test_schedule_weekly_is_due():
    # Sexta = 4. Em 2026, 11/jun é quinta; o último disparo foi sexta 05/jun 11h.
    sched = Schedule(frequency=Frequency.WEEKLY, weekday=4, hour=11)
    now = _utc(2026, 6, 11, 12, 0)
    assert sched.previous_fire(now) == _utc(2026, 6, 5, 11, 0)
    assert sched.is_due(now, last_run=_utc(2026, 6, 4, 9, 0))
    assert not sched.is_due(now, last_run=_utc(2026, 6, 5, 12, 0))


def test_schedule_monthly_is_due():
    sched = Schedule(frequency=Frequency.MONTHLY, day=1, hour=11)
    now = _utc(2026, 6, 11, 12, 0)
    assert sched.previous_fire(now) == _utc(2026, 6, 1, 11, 0)
    assert sched.is_due(now, last_run=_utc(2026, 5, 30, 0, 0))
    assert not sched.is_due(now, last_run=_utc(2026, 6, 1, 12, 0))
    # Antes do disparo do mês, o anterior é o do mês passado.
    early = _utc(2026, 6, 1, 9, 0)
    assert sched.previous_fire(early) == _utc(2026, 5, 1, 11, 0)


# ── Compilação heurística ────────────────────────────────────────────────────


def test_heuristica_extrai_agentes_e_agenda():
    compiled = _heuristic_compile(_TEXT_SEXTA)
    assert set(compiled.agents) >= {"monitor", "insight", "tax_optimizer"}
    assert compiled.frequency is Frequency.WEEKLY
    assert compiled.weekday == 4


def test_heuristica_frequencia_diaria_e_mensal():
    daily = _heuristic_compile("Todo dia, monitore os preços da carteira.")
    assert daily.frequency is Frequency.DAILY
    monthly = _heuristic_compile("No fechamento do mês, gere o relatório de portfólio.")
    assert monthly.frequency is Frequency.MONTHLY


# ── Serviço ──────────────────────────────────────────────────────────────────


class FakeAgent:
    """Agente fake com a interface mínima (make_msg + process)."""

    def __init__(self, client_id: str, **kwargs) -> None:
        self.client_id = client_id

    def make_msg(self, content: str) -> str:
        return content

    async def process(self, msg: str) -> str:
        return f"ok:{self.client_id}"


@pytest.fixture
def fake_registry(monkeypatch: pytest.MonkeyPatch) -> None:
    fakes = {name: FakeAgent for name in ("monitor", "insight", "tax_optimizer", "risk")}
    monkeypatch.setattr("carina.b2b.aops._agent_registry", lambda: fakes)


async def test_create_from_text_compila_e_persiste():
    svc = AOPService()
    aop = await svc.create_from_text(tenant_id="acme", text=_TEXT_SEXTA, client_ids=["c1", "c2"])
    assert set(aop.agents) >= {"monitor", "insight", "tax_optimizer"}
    assert aop.schedule.frequency is Frequency.WEEKLY
    assert (await svc.list_for_tenant("acme"))[0].id == aop.id
    assert await svc.list_for_tenant("warren") == []


async def test_create_sem_agentes_identificaveis_falha():
    svc = AOPService()
    with pytest.raises(AOPError):
        await svc.create_from_text(tenant_id="acme", text="Bom dia!", client_ids=["c1"])


async def test_run_executa_mede_e_audita(fake_registry: None):
    metering = MeteringService()
    watchtower = Watchtower()
    svc = AOPService(metering=metering, watchtower=watchtower)
    aop = await svc.create_from_text(tenant_id="acme", text=_TEXT_SEXTA, client_ids=["c1", "c2"])

    outcome = await svc.run(aop)
    assert set(outcome["runs"].keys()) == {"c1", "c2"}
    # Os agentes recebem o client_id já no namespace do tenant.
    assert outcome["runs"]["c1"]["results"]["monitor"] == "ok:acme__c1"
    # tax_optimizer presente → resolução classificada como optimization (R$30).
    assert outcome["runs"]["c1"]["usage"]["work_type"] == "optimization"

    summary = await metering.summary("acme")
    assert summary["resolutions"] == 2
    assert summary["total_brl"] == 60.00

    trail = await watchtower.trail("acme")
    assert len(trail) == 2
    assert all(e.channel == "aop" for e in trail)

    assert (await svc.get(aop.id)).last_run_at is not None


async def test_run_due_respeita_agenda(fake_registry: None):
    svc = AOPService()
    await svc.create_from_text(tenant_id="acme", text=_TEXT_SEXTA, client_ids=["c1"])

    # Nunca rodou → vence no primeiro ciclo; depois, só no próximo disparo.
    first = await svc.run_due(now=_utc(2026, 6, 11, 12, 0))
    assert len(first) == 1
    second = await svc.run_due(now=_utc(2026, 6, 11, 13, 0))
    assert second == []


async def test_set_enabled_e_run_due_ignora_desabilitado(fake_registry: None):
    svc = AOPService()
    aop = await svc.create_from_text(tenant_id="acme", text=_TEXT_SEXTA, client_ids=["c1"])
    await svc.set_enabled(aop.id, False)
    assert await svc.run_due(now=_utc(2026, 6, 11, 12, 0)) == []


# ── API ──────────────────────────────────────────────────────────────────────

_KEYS = "sk-acme:acme:Acme;sk-warren:warren:Warren"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, fake_registry: None):
    store = ApiKeyStore(settings=Settings(CARINA_API_KEYS=_KEYS, CARINA_ENV="test"))
    svc = AOPService()
    monkeypatch.setattr("carina.api.auth.get_api_key_store", lambda: store)
    monkeypatch.setattr("carina.api.routes.get_aop_service", lambda: svc)
    with TestClient(app) as c:
        yield c


def _auth(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


def test_api_cria_lista_roda_e_isola_por_tenant(client: TestClient):
    resp = client.post(
        "/api/aops",
        json={"text": _TEXT_SEXTA, "client_ids": ["c1"], "name": "Briefing de sexta"},
        headers=_auth("sk-acme"),
    )
    assert resp.status_code == 201
    aop = resp.json()
    assert aop["name"] == "Briefing de sexta"
    assert "tax_optimizer" in aop["agents"]

    listed = client.get("/api/aops", headers=_auth("sk-acme")).json()["aops"]
    assert [a["id"] for a in listed] == [aop["id"]]
    assert client.get("/api/aops", headers=_auth("sk-warren")).json()["aops"] == []

    # Outro tenant não roda nem altera (404, sem vazar existência).
    assert client.post(f"/api/aops/{aop['id']}/run", headers=_auth("sk-warren")).status_code == 404
    assert (
        client.patch(
            f"/api/aops/{aop['id']}", json={"enabled": False}, headers=_auth("sk-warren")
        ).status_code
        == 404
    )

    run = client.post(f"/api/aops/{aop['id']}/run", headers=_auth("sk-acme"))
    assert run.status_code == 200
    assert run.json()["runs"]["c1"]["usage"]["work_type"] == "optimization"

    patched = client.patch(
        f"/api/aops/{aop['id']}", json={"enabled": False}, headers=_auth("sk-acme")
    )
    assert patched.status_code == 200
    assert patched.json()["enabled"] is False


def test_api_descricao_sem_agentes_retorna_422(client: TestClient):
    resp = client.post(
        "/api/aops",
        json={"text": "Bom dia!", "client_ids": ["c1"]},
        headers=_auth("sk-acme"),
    )
    assert resp.status_code == 422


def test_api_aops_sem_chave_retorna_401(client: TestClient):
    assert client.get("/api/aops").status_code == 401
