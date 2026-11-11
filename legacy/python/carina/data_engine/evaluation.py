"""Agent Evaluation Layer ("SEAL BR") — Camada 3 do Data Engine.

Benchmark para avaliar se um agente de IA responde corretamente a perguntas
financeiras brasileiras (tributação, regulação CVM, Open Finance, produtos,
macro) — ``docs/B2B.md``: *"A Scale AI faz isso para LLMs genéricos; o CARINA
faz para o vertical financeiro brasileiro."*

Como funciona:
  1. O tenant lista o catálogo (``GET /api/eval/cases``) — perguntas SEM o
     gabarito (os fatos esperados nunca saem do servidor, senão o benchmark
     vira treino).
  2. Roda as perguntas no agente DELE e submete as respostas
     (``POST /api/eval/submit``).
  3. O CARINA corrige de forma **determinística** (fatos esperados por
     alternativas normalizadas, afirmações proibidas) e ainda roda as
     checagens de compliance do Watchtower em cada resposta — o relatório
     mede correção factual E postura regulatória.

A correção é por presença de fatos (substring normalizada: minúsculas, sem
acentos, vírgula decimal → ponto), não por LLM-judge — reproduzível, auditável
e barata, como convém a um benchmark de certificação.
"""

from __future__ import annotations

import unicodedata
from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, Field

from carina.b2b.watchtower import ComplianceFlag, inspect_text
from carina.utils.logging import get_logger

_log = get_logger("data_engine.evaluation")


class EvalCategory(str, Enum):
    """Categorias do benchmark financeiro BR."""

    TRIBUTACAO = "tributacao"
    CVM = "cvm"
    OPEN_FINANCE = "open_finance"
    PRODUTOS = "produtos"
    MACRO = "macro"


def _normalize(text: str) -> str:
    """Normaliza para comparação: minúsculas, sem acentos, ``,`` decimal → ``.``."""
    lowered = text.lower().replace(",", ".")
    stripped = unicodedata.normalize("NFKD", lowered)
    no_accents = "".join(ch for ch in stripped if not unicodedata.combining(ch))
    return " ".join(no_accents.split())


class ExpectedFact(BaseModel):
    """Um fato que a resposta deve conter (qualquer alternativa satisfaz)."""

    description: str = Field(min_length=1)
    alternatives: list[str] = Field(min_length=1)

    def present_in(self, normalized_answer: str) -> bool:
        """``True`` se alguma alternativa aparece na resposta normalizada."""
        return any(_normalize(alt) in normalized_answer for alt in self.alternatives)


class EvalCase(BaseModel):
    """Um caso do benchmark: pergunta + gabarito determinístico."""

    id: str = Field(min_length=1)
    category: EvalCategory
    difficulty: str = "medium"
    question: str = Field(min_length=1)
    expected_facts: list[ExpectedFact] = Field(min_length=1)
    forbidden: list[ExpectedFact] = Field(default_factory=list)
    reference: str = Field(default="", description="Norma/fonte (não exposta no catálogo).")

    def grade(self, answer: str) -> "CaseResult":
        """Corrige uma resposta: fatos presentes/ausentes, proibições, compliance."""
        normalized = _normalize(answer)
        matched = [f.description for f in self.expected_facts if f.present_in(normalized)]
        missing = [f.description for f in self.expected_facts if not f.present_in(normalized)]
        forbidden_hits = [f.description for f in self.forbidden if f.present_in(normalized)]
        score = len(matched) / len(self.expected_facts)
        return CaseResult(
            case_id=self.id,
            category=self.category,
            score=round(score, 4),
            passed=not missing and not forbidden_hits,
            matched=matched,
            missing=missing,
            forbidden_hits=forbidden_hits,
            compliance_flags=inspect_text(answer),
        )

    def public_view(self) -> dict:
        """Visão de catálogo — pergunta SEM gabarito nem referência."""
        return {
            "id": self.id,
            "category": self.category.value,
            "difficulty": self.difficulty,
            "question": self.question,
        }


class CaseResult(BaseModel):
    """Resultado da correção de um caso."""

    case_id: str
    category: EvalCategory
    score: float
    passed: bool
    matched: list[str] = Field(default_factory=list)
    missing: list[str] = Field(default_factory=list)
    forbidden_hits: list[str] = Field(default_factory=list)
    compliance_flags: list[ComplianceFlag] = Field(default_factory=list)


class EvalReport(BaseModel):
    """Relatório agregado de uma execução do benchmark."""

    answered: int
    passed: int
    pass_rate: float
    avg_score: float
    compliance_violations: int
    by_category: dict[str, dict] = Field(default_factory=dict)
    results: list[CaseResult] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class EvaluationService:
    """Catálogo e correção do benchmark SEAL BR.

    Args:
        cases: Dataset. Default: o dataset curado embarcado
            (:mod:`carina.data_engine.eval_dataset`).
    """

    def __init__(self, cases: list[EvalCase] | None = None) -> None:
        if cases is None:
            from carina.data_engine.eval_dataset import DATASET  # import tardio

            cases = DATASET
        self._cases: dict[str, EvalCase] = {c.id: c for c in cases}

    def catalog(self, category: EvalCategory | None = None) -> list[dict]:
        """Perguntas do benchmark (sem gabarito), opcionalmente por categoria."""
        return [
            case.public_view()
            for case in self._cases.values()
            if category is None or case.category is category
        ]

    def evaluate(self, answers: dict[str, str]) -> EvalReport:
        """Corrige um conjunto de respostas ``{case_id: resposta}``.

        Execução parcial é permitida (corrige só os casos respondidos).

        Raises:
            ValueError: Se algum ``case_id`` não existir no dataset.
        """
        unknown = sorted(set(answers) - set(self._cases))
        if unknown:
            raise ValueError(f"Casos inexistentes no benchmark: {', '.join(unknown)}")

        results = [self._cases[cid].grade(answer) for cid, answer in sorted(answers.items())]
        passed = sum(1 for r in results if r.passed)
        violations = sum(len(r.compliance_flags) for r in results)

        by_category: dict[str, dict] = {}
        for r in results:
            bucket = by_category.setdefault(
                r.category.value, {"answered": 0, "passed": 0, "avg_score": 0.0}
            )
            bucket["answered"] += 1
            bucket["passed"] += int(r.passed)
            bucket["avg_score"] += r.score
        for bucket in by_category.values():
            bucket["avg_score"] = round(bucket["avg_score"] / bucket["answered"], 4)

        report = EvalReport(
            answered=len(results),
            passed=passed,
            pass_rate=round(passed / len(results), 4) if results else 0.0,
            avg_score=round(sum(r.score for r in results) / len(results), 4) if results else 0.0,
            compliance_violations=violations,
            by_category=by_category,
            results=results,
        )
        _log.info(
            "evaluation.run",
            answered=report.answered,
            pass_rate=report.pass_rate,
            violations=violations,
        )
        return report
