"""Testes do Watchtower — checagens de compliance e trilha de auditoria."""

from __future__ import annotations

from carina.b2b.watchtower import Severity, Watchtower, inspect_text


def _codes(text: str) -> set[str]:
    return {f.code for f in inspect_text(text)}


def test_afirmacao_de_certeza_em_projecao_e_violacao():
    flags = inspect_text("Esse fundo tem retorno garantido de 2% ao mês.")
    assert any(
        f.code == "suitability.certainty_claim" and f.severity is Severity.VIOLATION for f in flags
    )


def test_recomendacao_direta_de_compra_e_violacao():
    assert "cvm.unauthorized_recommendation" in _codes("Recomendo comprar PETR4 hoje.")
    assert "cvm.unauthorized_recommendation" in _codes("Você deve vender suas ações.")


def test_pii_cpf_e_email_sao_detectados_sem_vazar_na_flag():
    flags = inspect_text("O titular é o CPF 123.456.789-01, contato joao@exemplo.com.")
    codes = {f.code for f in flags}
    assert "lgpd.pii_leak.cpf" in codes
    assert "lgpd.pii_leak.email" in codes
    # A flag descreve o tipo, nunca o valor da PII.
    for f in flags:
        assert "123.456.789-01" not in f.detail
        assert "joao@exemplo.com" not in f.detail


def test_projecao_sem_disclaimer_gera_warning():
    flags = inspect_text("A projeção de fluxo de caixa indica saldo positivo em 12 meses.")
    assert any(
        f.code == "suitability.missing_disclaimer" and f.severity is Severity.WARNING for f in flags
    )


def test_projecao_com_disclaimer_nao_gera_warning():
    text = (
        "A projeção de fluxo de caixa indica saldo positivo em 12 meses. "
        "Os valores são estimativas baseadas em premissas explícitas e não "
        "constituem recomendação."
    )
    assert "suitability.missing_disclaimer" not in _codes(text)


def test_texto_limpo_nao_gera_flags():
    assert inspect_text("Seu portfólio está alinhado aos seus objetivos.") == []


async def test_review_grava_evento_com_digest_e_flags():
    wt = Watchtower()
    event = await wt.review(
        tenant_id="acme",
        client_id="acme__c1",
        query="como está meu portfólio?",
        results={"insight": "Tudo certo.", "risk": "Retorno garantido de 5%."},
        duration_ms=120,
    )
    assert event.agents == ["insight", "risk"]
    assert len(event.response_digest) == 64
    assert any(f.code == "suitability.certainty_claim" for f in event.flags)

    trail = await wt.trail("acme")
    assert [e.id for e in trail] == [event.id]
    # Trilha isolada por tenant.
    assert await wt.trail("warren") == []
