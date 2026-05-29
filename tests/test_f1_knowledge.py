"""Teste de aceitação da F1: ingerir 1 doc num client_X, consultar e validar citação.

Há duas variantes:
  * unitária (default): mocka o ``GraphRAG`` do SDK — valida o fluxo do wrapper,
    o isolamento por ``graph_name`` e a extração da trilha de citação.
  * integração (``-m integration``): roda contra NIM + FalkorDB Cloud reais.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

import pytest

from carina.knowledge.graph import CarinaKnowledge, graph_name_for
from carina.knowledge.ingest import Document, ingest_documents
from carina.knowledge.query import query_graph
from tests.conftest import requires_live


def test_graph_name_isolation() -> None:
    assert graph_name_for("abc") == "client_abc"
    assert graph_name_for("123") != graph_name_for("124")


def test_graph_name_rejects_empty() -> None:
    from carina.utils.errors import KnowledgeError

    with pytest.raises(KnowledgeError):
        graph_name_for("  ")


class _FakeRag:
    """Dublê do ``GraphRAG`` do SDK para teste unitário."""

    def __init__(self) -> None:
        self.ingested: list[tuple[str, str]] = []
        self.finalized = False

    async def ingest(self, *, text: str, document_id: str) -> None:
        self.ingested.append((document_id, text))

    async def finalize(self) -> None:
        self.finalized = True

    async def completion(self, question: str, return_context: bool = True):  # type: ignore[no-untyped-def]
        assert return_context is True, "citação exige return_context=True"

        class _Result:
            answer = "Carlos detém PETR4."
            context = [{"source": "doc1", "snippet": "Carlos possui PETR4"}]

        return _Result()


@pytest.fixture
def mocked_knowledge(router, monkeypatch) -> tuple[CarinaKnowledge, _FakeRag]:
    """CarinaKnowledge com ``open()`` patchado para devolver um ``_FakeRag``."""
    kb = CarinaKnowledge(router=router)
    fake = _FakeRag()

    @asynccontextmanager
    async def fake_open(client_id: str):  # type: ignore[no-untyped-def]
        yield fake

    monkeypatch.setattr(kb, "open", fake_open)
    return kb, fake


@pytest.mark.asyncio
async def test_f1_ingest_finalize_query_with_citation(mocked_knowledge) -> None:
    kb, fake = mocked_knowledge
    client_id = "X"

    n = await ingest_documents(
        kb,
        client_id,
        [Document(document_id="doc1", text="Carlos possui PETR4.")],
    )
    assert n == 1
    assert fake.ingested == [("doc1", "Carlos possui PETR4.")]
    assert fake.finalized is True, "finalize deve ser chamado 1x ao fim do batch"

    answer = await query_graph(kb, client_id, "O que Carlos detém?")
    assert "PETR4" in answer.answer
    assert answer.context, "trilha de citação (context) obrigatória para compliance"


# ─────────────────────────────────────────────────────────────────────────────
# Integração real (NIM + FalkorDB Cloud). Rode com:  pytest -m integration
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.integration
@requires_live
@pytest.mark.asyncio
async def test_f1_live_roundtrip() -> None:
    kb = CarinaKnowledge()
    client_id = "test_f1"

    await ingest_documents(
        kb,
        client_id,
        [
            Document(
                document_id="f1-doc1",
                text="Carlos Mendes é um investidor que detém ações da Petrobras (PETR4) "
                "no setor de energia. Seu objetivo é aposentadoria em 20 anos.",
            )
        ],
    )

    answer = await query_graph(kb, client_id, "Quais ativos Carlos Mendes possui?")
    assert answer.answer, "resposta não vazia esperada"
    assert answer.context is not None, "return_context deve trazer a trilha de citação"
