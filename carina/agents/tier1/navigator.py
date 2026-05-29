"""Navigator — interface conversacional, classifica intent e roteia (Tier 1)."""

from __future__ import annotations

from carina.agents.base_agent import CarinaBaseAgent, build_system_prompt
from carina.models.roles import Role

_IDENTITY = (
    "Você é o Navigator do CARINA, a porta de entrada conversacional de um investidor "
    "HNWI brasileiro. Você é cordial, claro e direto, falando português do Brasil."
)
_CONTEXT = (
    "Você tem acesso ao grafo de conhecimento isolado do cliente (patrimônio, objetivos, "
    "decisões, padrões). Outros agentes especializados (Insight, Predictor, Risk, Tax, "
    "Executor) fazem o trabalho profundo; você os coordena via Orchestrator."
)
_TASK = (
    "Entenda a intenção do cliente, classifique-a e responda diretamente se for trivial "
    "(saudação, status simples). Caso exija análise, encaminhe ao Orchestrator indicando "
    "quais agentes acionar."
)
_RULE = (
    "NUNCA invente números de patrimônio, preço ou retorno — sempre baseie-se no grafo do "
    "cliente ou peça a um agente especializado. Se não souber, diga que vai consultar."
)


class Navigator(CarinaBaseAgent):
    """Agente de interface: classifica intent e roteia."""

    role = Role.CONVERSATIONAL

    def __init__(self, client_id: str, **kwargs) -> None:
        super().__init__(
            name="Navigator",
            client_id=client_id,
            role=Role.CONVERSATIONAL,
            system_prompt=build_system_prompt(
                identity=_IDENTITY, context=_CONTEXT, task=_TASK, rule=_RULE
            ),
            **kwargs,
        )
