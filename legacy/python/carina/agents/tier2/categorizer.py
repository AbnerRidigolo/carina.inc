"""Categorizer — categoriza transações, detecta recorrência/parcelas (Tier 2).

ML leve (heurística por regras/keywords) com fallback para LLM nos casos ambíguos.
Recategorizar é REVERSÍVEL → executa e notifica (via agentic-inbox, se acoplado).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from carina.models.roles import Role
from carina.models.router import ModelRouter, get_router
from carina.utils.logging import get_logger

_log = get_logger("Categorizer")

# Regras leves: categoria → keywords.
_RULES: dict[str, tuple[str, ...]] = {
    "investimento": ("corretora", "tesouro", "cdb", "fundo", "b3", "xp", "nuinvest"),
    "moradia": ("aluguel", "condomínio", "iptu", "luz", "água", "energia"),
    "alimentação": ("supermercado", "restaurante", "ifood", "mercado"),
    "transporte": ("uber", "99", "combustível", "posto", "estacionamento"),
    "saúde": ("farmácia", "hospital", "consulta", "plano de saúde"),
    "lazer": ("netflix", "spotify", "cinema", "viagem", "hotel"),
}

_INSTALLMENT_RE = re.compile(r"\b(\d{1,2})\s*/\s*(\d{1,2})\b")  # ex.: "3/12"


@dataclass
class Categorization:
    """Resultado da categorização de uma transação."""

    category: str
    confidence: float
    is_installment: bool = False
    installment: tuple[int, int] | None = None
    method: str = "rule"  # "rule" | "llm"


class Categorizer:
    """Categoriza transações com regras + fallback LLM.

    Args:
        router: Router de modelos (para o fallback LLM). Default: :func:`get_router`.
    """

    def __init__(self, router: ModelRouter | None = None) -> None:
        self._router = router or get_router()

    def detect_installment(self, description: str) -> tuple[int, int] | None:
        """Detecta padrão de parcela ``N/M`` na descrição."""
        m = _INSTALLMENT_RE.search(description)
        if not m:
            return None
        return int(m.group(1)), int(m.group(2))

    def _rule_match(self, description: str) -> str | None:
        desc = description.lower()
        for category, kws in _RULES.items():
            if any(k in desc for k in kws):
                return category
        return None

    async def categorize(self, description: str) -> Categorization:
        """Categoriza uma transação (regra primeiro, LLM como fallback).

        Args:
            description: Descrição da transação.

        Returns:
            :class:`Categorization`.
        """
        installment = self.detect_installment(description)
        category = self._rule_match(description)
        if category is not None:
            return Categorization(
                category=category,
                confidence=0.9,
                is_installment=installment is not None,
                installment=installment,
                method="rule",
            )

        # Ambíguo → fallback LLM (papel conversacional, com fallback de provedor).
        try:
            resp = await self._router.acompletion(
                Role.CONVERSATIONAL,
                messages=[
                    {
                        "role": "system",
                        "content": "Categorize a transação em UMA palavra dentre: "
                        + ", ".join(_RULES.keys())
                        + ", outros. Responda só a categoria.",
                    },
                    {"role": "user", "content": description},
                ],
            )
            cat = resp["choices"][0]["message"]["content"].strip().lower()
            _log.info("categorizer.llm", category=cat)
            return Categorization(
                category=cat,
                confidence=0.6,
                is_installment=installment is not None,
                installment=installment,
                method="llm",
            )
        except Exception as exc:  # noqa: BLE001 - fallback final
            _log.warning("categorizer.llm_failed", error=str(exc))
            return Categorization(
                category="outros",
                confidence=0.3,
                is_installment=installment is not None,
                installment=installment,
                method="rule",
            )
