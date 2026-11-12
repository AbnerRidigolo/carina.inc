"""Orchestrator (Zeus) — classifica complexidade e coordena o workflow multi-agente.

Estratégia:
  * **simples**  → Navigator responde direto.
  * **média**    → um agente especializado + Navigator sintetiza.
  * **complexa** → vários agentes em paralelo (``asyncio.gather``, ex.: Insight + Risk),
                   depois síntese.

A classificação usa o modelo de ``reasoning`` (saída estruturada); há heurística de
contingência se o modelo falhar, para nunca travar o event loop.
"""

from __future__ import annotations

import asyncio
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

from carina.agents.tier1.navigator import Navigator
from carina.agents.tier3.insight import Insight
from carina.agents.tier3.predictor import Predictor
from carina.agents.tier3.rebalancer_risk import RebalancerRisk
from carina.models.roles import Role
from carina.models.router import ModelRouter, get_router
from carina.utils.logging import get_logger

_log = get_logger(__name__)


class Complexity(str, Enum):
    """Nível de complexidade de uma solicitação."""

    SIMPLE = "simples"
    MEDIUM = "média"
    COMPLEX = "complexa"


class Plan(BaseModel):
    """Plano de execução produzido pela classificação."""

    complexity: Complexity = Field(description="Complexidade da solicitação.")
    agents: list[str] = Field(
        default_factory=list,
        description="Agentes a acionar: insight, predictor, risk.",
    )
    rationale: str = Field(default="", description="Por que esse plano.")


_CLASSIFIER_SYS = (
    "Você classifica a complexidade de uma pergunta de gestão patrimonial e decide quais "
    "agentes acionar. Responda em JSON com: complexity (simples|média|complexa), "
    "agents (lista de: insight, predictor, risk), rationale. "
    "Use 'simples' para saudações/status triviais (nenhum agente). "
    "Use 'média' para uma área (ex.: só insight). "
    "Use 'complexa' quando exigir múltiplas análises (ex.: insight + risk + predictor)."
)

_KEYWORDS = {
    "insight": ("portfólio", "gasto", "anomalia", "composição", "concentr"),
    "risk": ("risco", "var", "volatil", "stress", "correlação", "rebalance"),
    "predictor": ("projeção", "fluxo de caixa", "cenário", "futuro", "previsão"),
}


class Orchestrator:
    """Coordena os agentes para atender a uma solicitação do cliente.

    Args:
        client_id: Cliente atendido (define grafo e instâncias de agente).
        router: Router de modelos. Default: :func:`get_router`.
    """

    def __init__(self, client_id: str, router: ModelRouter | None = None) -> None:
        self.client_id = client_id
        self._router = router or get_router()
        self._log = _log.bind(client_id=client_id)
        self._navigator = Navigator(client_id, router=self._router)
        self._specialists: dict[str, Any] = {
            "insight": Insight(client_id, router=self._router),
            "predictor": Predictor(client_id, router=self._router),
            "risk": RebalancerRisk(client_id, router=self._router),
        }

    async def classify(self, query: str) -> Plan:
        """Classifica a solicitação, com contingência heurística.

        Args:
            query: Texto do cliente.

        Returns:
            :class:`Plan` com complexidade e agentes a acionar.
        """
        try:
            resp = await self._router.acompletion(
                Role.REASONING,
                messages=[
                    {"role": "system", "content": _CLASSIFIER_SYS},
                    {"role": "user", "content": query},
                ],
                response_format={"type": "json_object"},
            )
            content = resp["choices"][0]["message"]["content"]
            plan = Plan.model_validate_json(content)
            self._log.info("orchestrator.classified", complexity=plan.complexity.value)
            return plan
        except Exception as exc:  # noqa: BLE001 - contingência: nunca travar
            self._log.warning("orchestrator.classify_fallback", error=str(exc))
            return self._heuristic_plan(query)

    @staticmethod
    def _heuristic_plan(query: str) -> Plan:
        """Classificação por palavras-chave quando o modelo não está disponível."""
        q = query.lower()
        agents = [name for name, kws in _KEYWORDS.items() if any(k in q for k in kws)]
        if not agents:
            return Plan(complexity=Complexity.SIMPLE, rationale="sem termos analíticos")
        complexity = Complexity.COMPLEX if len(agents) > 1 else Complexity.MEDIUM
        return Plan(complexity=complexity, agents=agents, rationale="heurística por keywords")

    async def handle(self, query: str) -> dict[str, Any]:
        """Atende a solicitação ponta a ponta e retorna o resultado coordenado.

        Args:
            query: Texto do cliente.

        Returns:
            Dict com ``plan`` e ``results`` (saídas por agente / resposta final).
        """
        plan = await self.classify(query)
        msg = self._navigator.make_msg(query)

        if plan.complexity is Complexity.SIMPLE or not plan.agents:
            self._log.info("orchestrator.simple")
            answer = await self._navigator.process(msg)
            return {"plan": plan.model_dump(), "results": {"navigator": _content(answer)}}

        # Média/Complexa: roda os especialistas EM PARALELO (asyncio.gather).
        selected = [
            (name, self._specialists[name]) for name in plan.agents if name in self._specialists
        ]
        self._log.info("orchestrator.parallel", agents=[n for n, _ in selected])
        outputs = await asyncio.gather(
            *(agent.process(agent.make_msg(query)) for _, agent in selected),
            return_exceptions=True,
        )

        results: dict[str, Any] = {}
        for (name, _), out in zip(selected, outputs):
            results[name] = {"error": str(out)} if isinstance(out, Exception) else _content(out)
        return {"plan": plan.model_dump(), "results": results}


def _content(msg: Any) -> Any:
    """Extrai o conteúdo textual de um ``Msg`` do AgentScope (defensivo)."""
    content = getattr(msg, "content", msg)
    return content
