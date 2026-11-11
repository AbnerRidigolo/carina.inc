"""Testes do metering por resolução (store em memória)."""

from __future__ import annotations

import pytest

from carina.b2b.metering import (
    PRICE_BRL,
    MeteringService,
    WorkType,
    classify_work,
    extract_value_brl,
)
from carina.config.settings import Settings


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
    assert record.fee_brl == 0.0  # sem valor movimentado, só o preço base


async def test_execution_cobra_fee_sobre_valor():
    svc = MeteringService(settings=Settings(CARINA_ENV="test", CARINA_EXECUTION_FEE_PCT=0.5))
    record = await svc.record_resolution(
        tenant_id="acme",
        client_id="acme__c1",
        agents=["executor"],
        work_type=WorkType.EXECUTION,
        value_brl=100_000.0,
    )
    # 0,5% de R$100.000 = R$500 de fee + R$75 base.
    assert record.fee_brl == 500.00
    assert record.price_brl == 575.00
    assert record.value_brl == 100_000.0

    # Fee não se aplica a tipos que não são execução.
    analysis = await svc.record_resolution(
        tenant_id="acme", client_id="acme__c1", agents=["insight"], value_brl=100_000.0
    )
    assert analysis.fee_brl == 0.0
    assert analysis.price_brl == PRICE_BRL[WorkType.ANALYSIS]


def test_extract_value_brl():
    assert extract_value_brl({"amount": 5000.0}) == 5000.0
    assert extract_value_brl({"valor": -2500}) == 2500.0  # venda: valor absoluto
    assert extract_value_brl({"value_brl": 10.0, "amount": 99.0}) == 10.0  # precedência
    assert extract_value_brl({"amount": "muito"}) == 0.0  # não numérico
    assert extract_value_brl({"amount": True}) == 0.0  # bool não é valor
    assert extract_value_brl({}) == 0.0


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
