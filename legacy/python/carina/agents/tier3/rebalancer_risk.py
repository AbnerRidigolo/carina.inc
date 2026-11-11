"""Rebalancer + Risk Manager — drift, VaR, correlação, stress test (Tier 3, reasoning)."""

from __future__ import annotations

from pydantic import BaseModel, Field

from carina.agents.base_agent import CarinaBaseAgent, build_system_prompt
from carina.models.roles import Role


class RiskAssessment(BaseModel):
    """Avaliação de risco e proposta de rebalanceamento (saída estruturada)."""

    drift_pct: float = Field(description="Desvio (%) da alocação atual vs. alvo.")
    value_at_risk_brl: float = Field(description="VaR estimado (R$) no horizonte considerado.")
    top_correlations: list[str] = Field(description="Pares de ativos com alta correlação.")
    stress_findings: list[str] = Field(description="Resultados de cenários de stress.")
    rebalance_suggestions: list[str] = Field(
        description="Sugestões de rebalanceamento (apenas proposta, NÃO execução)."
    )


_IDENTITY = (
    "Você é o Rebalancer + Risk Manager do CARINA, responsável por risco e disciplina de "
    "alocação do portfólio de um investidor HNWI brasileiro."
)
_CONTEXT = (
    "Use o grafo (posições, setores, alvos de alocação) para medir drift, VaR, correlação e "
    "rodar stress tests. Modelo de raciocínio Hermes com <think>."
)
_TASK = (
    "Avalie risco e proponha rebalanceamento, retornando no schema RiskAssessment com "
    "métricas e justificativas."
)
_RULE = (
    "Você PROPÕE, não executa. Qualquer ordem real é encaminhada ao Executor e passa pela "
    "agentic-inbox (ação irreversível → aprovação humana)."
)


class RebalancerRisk(CarinaBaseAgent):
    """Análise de risco + propostas de rebalanceamento."""

    role = Role.REASONING

    def __init__(self, client_id: str, **kwargs) -> None:
        kwargs.setdefault("structured_model", RiskAssessment)
        super().__init__(
            name="RebalancerRisk",
            client_id=client_id,
            role=Role.REASONING,
            system_prompt=build_system_prompt(
                identity=_IDENTITY, context=_CONTEXT, task=_TASK, rule=_RULE
            ),
            **kwargs,
        )
