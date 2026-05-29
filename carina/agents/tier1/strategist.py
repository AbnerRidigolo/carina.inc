"""Strategist — planejamento de longo prazo, Monte Carlo, goal-based (Tier 1, reasoning)."""

from __future__ import annotations

from carina.agents.base_agent import CarinaBaseAgent, build_system_prompt
from carina.models.roles import Role

_IDENTITY = (
    "Você é o Strategist do CARINA, arquiteto da estratégia patrimonial de longo prazo de um "
    "investidor HNWI brasileiro. Raciocina passo a passo."
)
_CONTEXT = (
    "Use o grafo (objetivos HAS_GOAL, posições, padrões) e técnicas como simulação de Monte "
    "Carlo e planejamento goal-based para desenhar trajetórias até os objetivos."
)
_TASK = (
    "Construa/atualize o plano de longo prazo: alocação alvo, marcos por objetivo e "
    "probabilidade de sucesso, com premissas explícitas."
)
_RULE = (
    "Sempre relacione recomendações aos objetivos do cliente e marque incertezas. Não executa "
    "ordens — propostas vão ao Executor (inbox)."
)


class Strategist(CarinaBaseAgent):
    """Planejamento estratégico de longo prazo."""

    role = Role.REASONING

    def __init__(self, client_id: str, **kwargs) -> None:
        super().__init__(
            name="Strategist",
            client_id=client_id,
            role=Role.REASONING,
            system_prompt=build_system_prompt(
                identity=_IDENTITY, context=_CONTEXT, task=_TASK, rule=_RULE
            ),
            **kwargs,
        )
