"""Testes do metering por resolução (store em memória)."""

from __future__ import annotations

import pytest

from carina.b2b.metering import (
    PRICE_BRL,
    MeteringService,
    WorkType,
    classify_work,
)


@pytest.mark.parametrize(
    ("agents", "expected"),
    [
        ([], WorkType.QUERY),
        (["insight"], WorkType.ANALYSIS),
        (["risk"], WorkType.ANALYSIS),
        (["insight", "risk"], WorkType.MULTI_AGENT_ANALYSIS),
        (["insight", "predictor", "risk"], WorkType.MULTI_AGENT_ANALYSIS),
        (["tax_optimizer"], WorkType.OPTIMIZATION),
        (["insight", "rebalancer"], WorkType.OPTIMIZATION),
    ],
)
def test_classify_work(agents: list[str], expected: WorkType):
    assert classify_work(agents) == expected


async def test_record_aplica_preco_da_tabela():
    svc = MeteringService()
    record = await svc.record_resolution(
        tenant_id="acme", client_id="acme__c1", agents=["insight", "risk"], duration_ms=420
    )
    assert record.work_type is WorkType.MULTI_AGENT_ANALYSIS
    assert record.price_brl == PRICE_BRL[WorkType.MULTI_AGENT_ANALYSIS]
    assert record.duration_ms == 420


async def test_work_type_explicito_sobrepoe_classificacao():
    svc = MeteringService()
    record = await svc.record_resolution(
        tenant_id="acme", client_id="acme__c1", agents=[], work_type=WorkType.EXECUTION
    )
    assert record.work_type is WorkType.EXECUTION
    assert record.price_brl == PRICE_BRL[WorkType.EXECUTION]


async def test_summary_agrega_por_tipo_e_isola_tenants():
    svc = MeteringService()
    await svc.record_resolution(tenant_id="acme", client_id="acme__c1", agents=[])
    await svc.record_resolution(tenant_id="acme", client_id="acme__c1", agents=[])
    await svc.record_resolution(tenant_id="acme", client_id="acme__c2", agents=["insight"])
    await svc.record_resolution(tenant_id="warren", client_id="warren__c1", agents=[])

    summary = await svc.summary("acme")
    assert summary["resolutions"] == 3
    assert summary["by_work_type"]["query"]["count"] == 2
    assert summary["by_work_type"]["query"]["total_brl"] == 3.00
    assert summary["by_work_type"]["analysis"]["count"] == 1
    assert summary["total_brl"] == 10.50

    other = await svc.summary("warren")
    assert other["resolutions"] == 1
