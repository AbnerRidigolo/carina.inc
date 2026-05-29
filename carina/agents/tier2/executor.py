"""Executor — prepara ações financeiras; irreversíveis SEMPRE via agentic-inbox (Tier 2)."""

from __future__ import annotations

from typing import Any

from carina.agents.base_agent import CarinaBaseAgent, build_system_prompt
from carina.inbox.models import ApprovalRequest, RiskClass
from carina.inbox.service import InboxService
from carina.models.roles import Role

_IDENTITY = (
    "Você é o Executor do CARINA, responsável por PREPARAR ações financeiras de um investidor "
    "HNWI brasileiro com precisão e prudência."
)
_CONTEXT = (
    "Você recebe propostas (do Rebalancer, Tax, Strategist) e as transforma em ações concretas "
    "com payload validado. Toda ação que mova dinheiro ou seja irreversível passa pela "
    "agentic-inbox para aprovação humana."
)
_TASK = (
    "Monte o payload da ação, classifique seu risco e submeta à inbox. Para ações irreversíveis, "
    "NUNCA execute — aguarde aprovação."
)
_RULE = (
    "Movimento de dinheiro, ordem de trade, transferência e envio externo são SEMPRE "
    "IRREVERSÍVEIS → aprovação humana obrigatória. Em dúvida, classifique como irreversível."
)

# Ações sempre tratadas como irreversíveis (movem dinheiro / são externas).
_IRREVERSIBLE_ACTIONS = {"place_trade", "transfer", "withdraw", "send_external", "rebalance"}


class Executor(CarinaBaseAgent):
    """Prepara e submete ações; aplica a política de risco da inbox.

    Args:
        client_id: Cliente atendido.
        inbox: Serviço de inbox (compartilhado pela aplicação).
    """

    role = Role.REASONING

    def __init__(self, client_id: str, inbox: InboxService, **kwargs) -> None:
        self._inbox = inbox
        super().__init__(
            name="Executor",
            client_id=client_id,
            role=Role.REASONING,
            system_prompt=build_system_prompt(
                identity=_IDENTITY, context=_CONTEXT, task=_TASK, rule=_RULE
            ),
            **kwargs,
        )

    @staticmethod
    def classify_risk(action: str) -> RiskClass:
        """Classifica o risco de uma ação pelo seu nome.

        Args:
            action: Nome da ação.

        Returns:
            :class:`~carina.inbox.models.RiskClass`.
        """
        if action in _IRREVERSIBLE_ACTIONS:
            return RiskClass.IRREVERSIBLE
        if action.startswith(("get_", "read_", "analyze_")):
            return RiskClass.READ
        return RiskClass.REVERSIBLE

    async def submit_action(self, action: str, payload: dict[str, Any]) -> dict:
        """Prepara uma ação e a submete à inbox conforme o risco.

        Args:
            action: Nome da ação (deve ter executor registrado na inbox).
            payload: Parâmetros já validados.

        Returns:
            Resultado da submissão (executado ou ``pending``).
        """
        risk = self.classify_risk(action)
        request = ApprovalRequest.create(
            client_id=self.client_id, agent=self.name, action=action, risk=risk, payload=payload
        )
        self._log.info("executor.submit", action=action, risk=risk.value)
        return await self._inbox.submit(request)
