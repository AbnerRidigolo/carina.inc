"""Testes do SEAL BR — Agent Evaluation Layer (Camada 3 do Data Engine)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from carina.api.app import app
from carina.b2b.metering import MeteringService
from carina.b2b.tenants import ApiKeyStore
from carina.config.settings import Settings
from carina.data_engine.eval_dataset import DATASET
from carina.data_engine.evaluation import (
    EvalCase,
    EvalCategory,
    EvaluationService,
    ExpectedFact,
    _normalize,
)

# ── Integridade do dataset curado ────────────────────────────────────────────


def test_dataset_tem_ids_unicos_e_tamanho_minimo():
    ids = [c.id for c in DATASET]
    assert len(ids) == len(set(ids))
    assert len(DATASET) >= 40


def test_dataset_cobre_todas_as_categorias():
    categorias = {c.category for c in DATASET}
    assert categorias == set(EvalCategory)


def test_dataset_todos_os_casos_tem_gabarito_e_referencia():
    for case in DATASET:
        assert case.expected_facts, case.id
        assert all(f.alternatives for f in case.expected_facts), case.id
        assert case.reference, case.id  # fonte normativa obrigatória na curadoria


# ── Normalização e correção ──────────────────────────────────────────────────


def test_normalizacao_acentos_e_virgula_decimal():
    assert _normalize("Isenção de 22,5%  ao ANO") == "isencao de 22.5% ao ano"


def _case() -> EvalCase:
    return EvalCase(
        id="t",
        category=EvalCategory.TRIBUTACAO,
        question="q?",
        expected_facts=[
            ExpectedFact(description="alíquota 22,5%", alternatives=["22.5"]),
            ExpectedFact(description="isenção", alternatives=["isen"]),
        ],
        forbidden=[ExpectedFact(description="27,5% (errado)", alternatives=["27.5"])],
    )


def test_resposta_correta_passa():
    result = _case().grade("Há isenção até o limite; acima, a alíquota é de 22,5%.")
    assert result.passed
    assert result.score == 1.0
    assert result.missing == []


def test_resposta_incompleta_lista_fatos_faltantes():
    result = _case().grade("A alíquota é de 22,5%.")
    assert not result.passed
    assert result.score == 0.5
    assert result.missing == ["isenção"]


def test_afirmacao_proibida_reprova_mesmo_com_fatos_corretos():
    result = _case().grade("Isenção até o limite; acima, 22,5% — ou seria 27,5%?")
    assert not result.passed
    assert result.forbidden_hits == ["27,5% (errado)"]


def test_resposta_com_violacao_de_compliance_e_flagrada():
    result = _case().grade("Isenção garantida e retorno garantido de 22,5%!")
    assert any(f.code == "suitability.certainty_claim" for f in result.compliance_flags)


def test_caso_real_acoes_isencao():
    svc = EvaluationService()
    report = svc.evaluate(
        {
            "acoes-isencao-20k": (
                "Não paga: vendas de até R$ 20.000 no mês em operações comuns são "
                "isentas de IR para pessoa física."
            )
        }
    )
    assert report.passed == 1
    assert report.pass_rate == 1.0


# ── EvaluationService (catálogo e agregação) ─────────────────────────────────


def test_catalogo_nao_vaza_gabarito_nem_referencia():
    for entry in EvaluationService().catalog():
        assert set(entry) == {"id", "category", "difficulty", "question"}


def test_catalogo_filtra_por_categoria():
    cvm = EvaluationService().catalog(EvalCategory.CVM)
    assert cvm
    assert all(e["category"] == "cvm" for e in cvm)


def test_evaluate_agrega_por_categoria_e_permite_execucao_parcial():
    svc = EvaluationService()
    report = svc.evaluate(
        {
            "lci-lca": "LCI e LCA são isentas de IR para pessoa física.",
            "ptax": "É a taxa de referência do dólar divulgada pelo Banco Central.",
            "copom-selic": "Quem define é o governo, todo mês.",  # errada
        }
    )
    assert report.answered == 3
    assert report.passed == 2
    assert report.by_category["tributacao"]["passed"] == 1
    assert report.by_category["macro"]["answered"] == 2
    assert report.by_category["macro"]["passed"] == 1


def test_evaluate_caso_inexistente_falha_explicito():
    with pytest.raises(ValueError, match="nao-existe"):
        EvaluationService().evaluate({"nao-existe": "resposta"})


# ── API ──────────────────────────────────────────────────────────────────────

_KEYS = "sk-acme:acme:Acme"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    key_store = ApiKeyStore(settings=Settings(CARINA_API_KEYS=_KEYS, CARINA_ENV="test"))
    metering = MeteringService()
    monkeypatch.setattr("carina.api.auth.get_api_key_store", lambda: key_store)
    monkeypatch.setattr("carina.api.routes.get_metering", lambda: metering)
    with TestClient(app) as c:
        yield c


def _auth(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


def test_api_catalogo_exige_auth_e_nao_vaza_gabarito(client: TestClient):
    assert client.get("/api/eval/cases").status_code == 401

    resp = client.get("/api/eval/cases", headers=_auth("sk-acme"))
    assert resp.status_code == 200
    cases = resp.json()["cases"]
    assert len(cases) >= 15
    assert all("expected_facts" not in c and "reference" not in c for c in cases)

    filtered = client.get("/api/eval/cases?category=cvm", headers=_auth("sk-acme")).json()
    assert all(c["category"] == "cvm" for c in filtered["cases"])
    assert client.get("/api/eval/cases?category=xyz", headers=_auth("sk-acme")).status_code == 422


def test_api_submit_corrige_e_cobra_execucao(client: TestClient):
    resp = client.post(
        "/api/eval/submit",
        json={"answers": {"lci-lca": "São isentas de imposto de renda para pessoa física."}},
        headers=_auth("sk-acme"),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["passed"] == 1
    assert body["usage"] == {"work_type": "evaluation", "price_brl": 5.00}

    usage = client.get("/api/usage", headers=_auth("sk-acme")).json()
    assert usage["by_work_type"]["evaluation"]["count"] == 1


def test_api_submit_caso_inexistente_retorna_422(client: TestClient):
    resp = client.post(
        "/api/eval/submit",
        json={"answers": {"nao-existe": "x"}},
        headers=_auth("sk-acme"),
    )
    assert resp.status_code == 422
