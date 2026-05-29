"""Testes do Orchestrator (Zeus): classificação heurística e coordenação paralela."""

from __future__ import annotations

import pytest

from carina.agents.orchestrator import Complexity, Orchestrator, Plan


@pytest.fixture
def orch(router) -> Orchestrator:
    return Orchestrator(client_id="X", router=router)


def test_heuristic_simple(orch: Orchestrator) -> None:
    plan = orch._heuristic_plan("Bom dia, tudo bem?")
    assert plan.complexity is Complexity.SIMPLE
    assert plan.agents == []


def test_heuristic_medium_single_agent(orch: Orchestrator) -> None:
    plan = orch._heuristic_plan("Como está a composição do meu portfólio?")
    assert plan.complexity is Complexity.MEDIUM
    assert plan.agents == ["insight"]


def test_heuristic_complex_multi_agent(orch: Orchestrator) -> None:
    plan = orch._heuristic_plan("Qual meu risco (VaR) e a projeção de fluxo de caixa?")
    assert plan.complexity is Complexity.COMPLEX
    assert set(plan.agents) == {"risk", "predictor"}


@pytest.mark.asyncio
async def test_handle_runs_specialists_in_parallel(orch: Orchestrator, monkeypatch) -> None:
    """Plano complexo → Insight e Risk processam (mockados) e ambos retornam."""

    async def fake_classify(query: str) -> Plan:
        return Plan(complexity=Complexity.COMPLEX, agents=["insight", "risk"])

    monkeypatch.setattr(orch, "classify", fake_classify)

    async def make_fake(name: str):
        async def fake_process(msg):  # type: ignore[no-untyped-def]
            return f"{name}-resposta"

        return fake_process

    monkeypatch.setattr(orch._specialists["insight"], "process", await make_fake("insight"))
    monkeypatch.setattr(orch._specialists["risk"], "process", await make_fake("risk"))

    out = await orch.handle("risco e portfólio")
    assert out["plan"]["complexity"] == "complexa"
    assert out["results"]["insight"] == "insight-resposta"
    assert out["results"]["risk"] == "risk-resposta"


@pytest.mark.asyncio
async def test_handle_simple_uses_navigator(orch: Orchestrator, monkeypatch) -> None:
    async def fake_classify(query: str) -> Plan:
        return Plan(complexity=Complexity.SIMPLE, agents=[])

    monkeypatch.setattr(orch, "classify", fake_classify)

    async def fake_process(msg):  # type: ignore[no-untyped-def]
        return "olá!"

    monkeypatch.setattr(orch._navigator, "process", fake_process)

    out = await orch.handle("bom dia")
    assert out["results"]["navigator"] == "olá!"
