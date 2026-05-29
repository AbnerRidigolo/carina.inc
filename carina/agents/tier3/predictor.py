"""Predictor — projeção de fluxo de caixa 12–36m e cenários macro (Tier 3, reasoning)."""

from __future__ import annotations

from pydantic import BaseModel, Field

from carina.agents.base_agent import CarinaBaseAgent, build_system_prompt
from carina.models.roles import Role


class CashFlowScenario(BaseModel):
    """Cenário de projeção de fluxo de caixa (saída estruturada do Predictor)."""

    name: str = Field(description="Nome do cenário: base, otimista, pessimista.")
    horizon_months: int = Field(description="Horizonte da projeção em meses (12–36).")
    assumptions: list[str] = Field(description="Premissas macro/idiossincráticas usadas.")
    projected_net_flow_brl: float = Field(description="Fluxo de caixa líquido projetado (R$).")
    confidence: float = Field(ge=0.0, le=1.0, description="Confiança do cenário (0–1).")


class CashFlowForecast(BaseModel):
    """Projeção completa com múltiplos cenários."""

    scenarios: list[CashFlowScenario]
    narrative: str = Field(description="Resumo interpretativo das projeções.")


_IDENTITY = (
    "Você é o Predictor do CARINA, especialista em projeção de fluxo de caixa e cenários "
    "macroeconômicos para um investidor HNWI brasileiro. Você raciocina passo a passo."
)
_CONTEXT = (
    "Use o grafo do cliente (posições, objetivos, padrões de gasto, decisões) e premissas "
    "macro (juros, câmbio, inflação) para projetar 12 a 36 meses. Modelo de raciocínio "
    "Hermes com <think> habilitado para deliberação."
)
_TASK = (
    "Gere cenários base/otimista/pessimista de fluxo de caixa, com premissas explícitas e "
    "nível de confiança, retornando no schema CashFlowForecast."
)
_RULE = (
    "Sempre explicite as premissas e marque a confiança. NUNCA apresente projeção como "
    "certeza. Baseie números iniciais no grafo do cliente."
)


class Predictor(CarinaBaseAgent):
    """Projeção de fluxo de caixa com raciocínio estruturado."""

    role = Role.REASONING

    def __init__(self, client_id: str, **kwargs) -> None:
        kwargs.setdefault("structured_model", CashFlowForecast)
        super().__init__(
            name="Predictor",
            client_id=client_id,
            role=Role.REASONING,
            system_prompt=build_system_prompt(
                identity=_IDENTITY, context=_CONTEXT, task=_TASK, rule=_RULE
            ),
            **kwargs,
        )
