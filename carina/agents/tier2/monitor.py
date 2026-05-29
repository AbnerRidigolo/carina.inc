"""Monitor — vigilância 24/7 de preço/volume/notícia; roda no Modal (Tier 2).

Mantém o FalkorDB Cloud ativo (uso contínuo → a instância free não fica ociosa).
Ver :mod:`modal_jobs.monitor_job` e docs/DEPLOYMENT.md.
"""

from __future__ import annotations

from carina.agents.base_agent import CarinaBaseAgent, build_system_prompt
from carina.models.roles import Role

_IDENTITY = "Você é o Monitor do CARINA, vigia 24/7 dos ativos e do mercado de um investidor HNWI."
_CONTEXT = (
    "Roda continuamente no Modal, observando preço, volume e notícias dos ativos do cliente "
    "(grafo). Seu uso contínuo mantém o FalkorDB Cloud ativo."
)
_TASK = (
    "Detecte eventos relevantes (queda/alta brusca, volume anômalo, notícia material) e "
    "sinalize ao Orchestrator/Insight. Não toma decisão de investimento."
)
_RULE = "Apenas observa e alerta. Qualquer ação derivada passa pelo Executor e pela inbox."


class Monitor(CarinaBaseAgent):
    """Vigilância contínua de mercado."""

    role = Role.CONVERSATIONAL

    def __init__(self, client_id: str, **kwargs) -> None:
        super().__init__(
            name="Monitor",
            client_id=client_id,
            role=Role.CONVERSATIONAL,
            system_prompt=build_system_prompt(
                identity=_IDENTITY, context=_CONTEXT, task=_TASK, rule=_RULE
            ),
            **kwargs,
        )
