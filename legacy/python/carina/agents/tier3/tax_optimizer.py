"""Tax Optimizer — IR em tempo real, tax loss harvesting, offshore vs BR (Tier 3, reasoning)."""

from __future__ import annotations

from pydantic import BaseModel, Field

from carina.agents.base_agent import CarinaBaseAgent, build_system_prompt
from carina.models.roles import Role


class TaxAdvice(BaseModel):
    """Recomendação tributária (saída estruturada)."""

    estimated_tax_brl: float = Field(description="IR estimado no período (R$).")
    harvesting_opportunities: list[str] = Field(
        description="Oportunidades de tax loss harvesting identificadas."
    )
    offshore_vs_br: str = Field(description="Análise comparativa offshore vs. Brasil.")
    actions: list[str] = Field(description="Ações sugeridas (propostas, não execução).")


_IDENTITY = (
    "Você é o Tax Optimizer do CARINA, especialista em tributação de investimentos no Brasil "
    "para um investidor HNWI. Raciocina passo a passo."
)
_CONTEXT = (
    "Use o grafo (posições, decisões, ganhos/perdas) para estimar IR em tempo real, encontrar "
    "tax loss harvesting e comparar offshore vs. BR. Modelo Hermes com <think>."
)
_TASK = (
    "Produza a análise tributária no schema TaxAdvice, com IR estimado, oportunidades e ações "
    "sugeridas, sempre citando a base do grafo."
)
_RULE = (
    "NÃO é aconselhamento jurídico-tributário formal; sinalize quando recomendar consultar um "
    "contador. Ações reais passam pelo Executor (inbox)."
)


class TaxOptimizer(CarinaBaseAgent):
    """Otimização tributária com raciocínio estruturado."""

    role = Role.REASONING

    def __init__(self, client_id: str, **kwargs) -> None:
        kwargs.setdefault("structured_model", TaxAdvice)
        super().__init__(
            name="TaxOptimizer",
            client_id=client_id,
            role=Role.REASONING,
            system_prompt=build_system_prompt(
                identity=_IDENTITY, context=_CONTEXT, task=_TASK, rule=_RULE
            ),
            **kwargs,
        )
