"""Helpers de consulta ao grafo do cliente, com trilha de citação (compliance).

Toda resposta de conhecimento deve poder citar a fonte → sempre usar
``return_context=True`` e expor o contexto recuperado.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from carina.knowledge.graph import CarinaKnowledge
from carina.utils.errors import KnowledgeError
from carina.utils.logging import get_logger

_log = get_logger(__name__)


@dataclass
class GraphAnswer:
    """Resposta de consulta ao grafo com trilha de citação.

    Attributes:
        answer: Texto da resposta gerada.
        context: Contexto recuperado (nós/arestas/trechos) que fundamenta a
            resposta — base da citação para compliance.
        raw: Objeto bruto retornado pelo SDK (para inspeção/depuração).
    """

    answer: str
    context: Any
    raw: Any


def _extract(result: Any) -> GraphAnswer:
    """Normaliza o retorno do ``completion`` do SDK para :class:`GraphAnswer`."""
    answer = getattr(result, "answer", None)
    if answer is None and isinstance(result, dict):
        answer = result.get("answer")
    context = getattr(result, "context", None)
    if context is None and isinstance(result, dict):
        context = result.get("context")
    return GraphAnswer(answer=answer or "", context=context, raw=result)


async def query_graph(
    knowledge: CarinaKnowledge,
    client_id: str,
    question: str,
    *,
    return_context: bool = True,
) -> GraphAnswer:
    """Consulta o grafo do cliente e retorna resposta + contexto de citação.

    Args:
        knowledge: Fachada da camada de conhecimento.
        client_id: Cliente alvo (grafo isolado).
        question: Pergunta em linguagem natural.
        return_context: Mantém ``True`` para trilha de citação (compliance).

    Returns:
        :class:`GraphAnswer` com resposta e contexto recuperado.

    Raises:
        KnowledgeError: Em falha de consulta.
    """
    log = _log.bind(client_id=client_id)
    try:
        async with knowledge.open(client_id) as rag:
            result = await rag.completion(question, return_context=return_context)
        answer = _extract(result)
        log.info("knowledge.query", has_context=answer.context is not None)
        return answer
    except KnowledgeError:
        raise
    except Exception as exc:  # noqa: BLE001 - fronteira
        log.error("knowledge.query_failed", error=str(exc))
        raise KnowledgeError(f"Falha ao consultar grafo de {client_id}: {exc}") from exc
