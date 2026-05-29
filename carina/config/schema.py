"""Schema (ontologia) do grafo de conhecimento CARINA.

Define quais entidades e relações o pipeline de extração do GraphRAG-SDK captura.
O mesmo schema é aplicado a TODOS os grafos de cliente (``client_<id>``) — o
isolamento é por grafo, a ontologia é compartilhada.

O ``GraphSchema`` é construído sob demanda por :func:`get_carina_schema` (import
tardio do ``graphrag_sdk``), para não acoplar a importação dos módulos da aplicação
à dependência pesada.

Construtores do GraphRAG-SDK:
    EntityType(label=..., description=...)
    RelationType(label=..., description=..., patterns=[(src_label, dst_label), ...])
    GraphSchema(entities=[...], relations=[...])
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

# ── Entidades (label, description) ────────────────────────────────────────────
_ENTITY_DEFS: list[tuple[str, str]] = [
    ("Client", "O investidor HNWI titular do patrimônio (perfil, tolerância a risco, horizonte)."),
    ("Asset", "Ativo financeiro detido pelo cliente: ação, fundo, renda fixa, cripto, imóvel."),
    ("Goal", "Objetivo financeiro do cliente: aposentadoria, compra, sucessão, meta de retorno."),
    ("Decision", "Decisão de investimento tomada ou aprovada: compra, venda, rebalanceamento."),
    ("Pattern", "Padrão comportamental/financeiro: aversão a perda, gasto recorrente, viés."),
    ("Assessor", "Assessor humano consultado (banco, corretora) e o conhecimento que fornece."),
    ("Sector", "Setor econômico de um ativo: tecnologia, energia, financeiro, imobiliário, etc."),
]

# ── Relações (label, description, patterns) ───────────────────────────────────
_RELATION_DEFS: list[tuple[str, str, list]] = [
    ("HOLDS", "O cliente detém (possui posição em) um ativo.", [("Client", "Asset")]),
    ("HAS_GOAL", "O cliente possui um objetivo financeiro.", [("Client", "Goal")]),
    (
        "MADE_DECISION",
        "O cliente tomou/aprovou uma decisão de investimento.",
        [("Client", "Decision")],
    ),
    (
        "HAS_PATTERN",
        "O cliente exibe um padrão comportamental/financeiro.",
        [("Client", "Pattern")],
    ),
    ("USES_ASSESSOR", "O cliente utiliza/consulta um assessor humano.", [("Client", "Assessor")]),
    ("IN_SECTOR", "Um ativo pertence a um setor econômico.", [("Asset", "Sector")]),
    ("SIMILAR_TO", "Dois clientes têm perfis/objetivos semelhantes.", [("Client", "Client")]),
]


@lru_cache
def get_carina_schema() -> Any:
    """Constrói (uma vez) o ``graphrag_sdk.GraphSchema`` do CARINA.

    Returns:
        Instância de ``GraphSchema`` com as entidades/relações do CARINA.
    """
    from graphrag_sdk import EntityType, GraphSchema, RelationType

    entities = [EntityType(label=label, description=desc) for label, desc in _ENTITY_DEFS]
    relations = [
        RelationType(label=label, description=desc, patterns=patterns)
        for label, desc, patterns in _RELATION_DEFS
    ]
    return GraphSchema(entities=entities, relations=relations)


__all__ = ["get_carina_schema"]
