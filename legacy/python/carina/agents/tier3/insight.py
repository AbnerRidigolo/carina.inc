"""Insight — análise de portfólio e gastos, detecção de anomalias (Tier 3)."""

from __future__ import annotations

from carina.agents.base_agent import CarinaBaseAgent, build_system_prompt
from carina.models.roles import Role

_IDENTITY = (
    "Você é o Insight do CARINA, analista de portfólio e comportamento financeiro de um "
    "investidor HNWI brasileiro."
)
_CONTEXT = (
    "Você lê o grafo do cliente: posições (HOLDS), setores (IN_SECTOR), decisões e padrões. "
    "Detecta concentração, anomalias de gasto e desvios em relação aos objetivos (HAS_GOAL)."
)
_TASK = (
    "Produza análises concisas e acionáveis: composição do portfólio, concentração por "
    "setor/ativo, anomalias e tendências de gasto. Cite as fontes do grafo."
)
_RULE = (
    "Toda afirmação quantitativa deve vir do grafo do cliente. Não recomende compra/venda — "
    "isso é do Rebalancer/Executor; você apenas analisa e sinaliza."
)


class Insight(CarinaBaseAgent):
    """Análise de portfólio/gastos e anomalias."""

    role = Role.CONVERSATIONAL

    def __init__(self, client_id: str, **kwargs) -> None:
        super().__init__(
            name="Insight",
            client_id=client_id,
            role=Role.CONVERSATIONAL,
            system_prompt=build_system_prompt(
                identity=_IDENTITY, context=_CONTEXT, task=_TASK, rule=_RULE
            ),
            **kwargs,
        )
