"""AOPs — Agent Operating Procedures (``docs/B2B.md``, Modo 2 de integração).

Um AOP é um procedimento recorrente definido pelo tenant **em linguagem
natural** — ex.: *"toda sexta, monitore as carteiras premium, gere análise de
portfólio e identifique oportunidades tributárias"* — que o CARINA compila em
uma automação: quais agentes acionar, em qual agenda, para quais clientes.

A compilação usa o modelo de ``reasoning`` (saída estruturada) com contingência
heurística por palavras-chave — o mesmo padrão do Orchestrator: nunca travar.

Cada execução de AOP por cliente é uma resolução cobrável (metering) e passa
pelo Watchtower como qualquer interação de agente.
"""

from __future__ import annotations

import abc
import asyncio
import time
import uuid
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field

from carina.b2b.metering import MeteringService
from carina.b2b.tenants import Tenant, ensure_valid_client_id, scoped_client_id
from carina.b2b.watchtower import Watchtower
from carina.config.settings import Settings, get_settings
from carina.models.roles import Role
from carina.models.router import ModelRouter
from carina.utils.errors import AOPError
from carina.utils.logging import get_logger

_log = get_logger(__name__)


def _agent_registry() -> dict[str, type]:
    """Agentes acionáveis por AOP (import tardio para não pesar na subida).

    Executor fica de fora de propósito: ação irreversível só via agentic-inbox.
    """
    from carina.agents.tier1.researcher import Researcher
    from carina.agents.tier1.strategist import Strategist
    from carina.agents.tier2.monitor import Monitor
    from carina.agents.tier3.insight import Insight
    from carina.agents.tier3.predictor import Predictor
    from carina.agents.tier3.rebalancer_risk import RebalancerRisk
    from carina.agents.tier3.tax_optimizer import TaxOptimizer

    return {
        "monitor": Monitor,
        "insight": Insight,
        "predictor": Predictor,
        "risk": RebalancerRisk,
        "tax_optimizer": TaxOptimizer,
        "researcher": Researcher,
        "strategist": Strategist,
    }


#: Nomes de agente válidos em um AOP.
ALLOWED_AGENTS = (
    "monitor",
    "insight",
    "predictor",
    "risk",
    "tax_optimizer",
    "researcher",
    "strategist",
)


# ── Agenda ───────────────────────────────────────────────────────────────────


class Frequency(str, Enum):
    """Frequência de execução de um AOP."""

    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"


class Schedule(BaseModel):
    """Agenda de execução (horários em UTC).

    Attributes:
        frequency: Diária, semanal ou mensal.
        weekday: Dia da semana (0=segunda … 6=domingo), usado em ``WEEKLY``.
        day: Dia do mês (1–28), usado em ``MONTHLY``.
        hour: Hora UTC do disparo (0–23).
    """

    frequency: Frequency = Frequency.WEEKLY
    weekday: int = Field(default=4, ge=0, le=6)
    day: int = Field(default=1, ge=1, le=28)
    hour: int = Field(default=11, ge=0, le=23)

    def previous_fire(self, now: datetime) -> datetime:
        """O disparo agendado mais recente que é ``<= now``."""
        anchor = now.replace(hour=self.hour, minute=0, second=0, microsecond=0)
        if self.frequency is Frequency.DAILY:
            return anchor if anchor <= now else anchor - timedelta(days=1)
        if self.frequency is Frequency.WEEKLY:
            anchor -= timedelta(days=(now.weekday() - self.weekday) % 7)
            return anchor if anchor <= now else anchor - timedelta(days=7)
        # MONTHLY
        anchor = anchor.replace(day=self.day)
        if anchor <= now:
            return anchor
        first_of_month = anchor.replace(day=1)
        return (first_of_month - timedelta(days=1)).replace(day=self.day, hour=self.hour)

    def is_due(self, now: datetime, last_run: datetime | None) -> bool:
        """``True`` se há um disparo agendado ainda não executado."""
        return last_run is None or last_run < self.previous_fire(now)


# ── Modelo ───────────────────────────────────────────────────────────────────


class AOP(BaseModel):
    """Procedimento operacional de agentes de um tenant."""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    tenant_id: str
    name: str = Field(min_length=1)
    description: str = Field(min_length=1, description="Texto original em linguagem natural.")
    agents: list[str] = Field(min_length=1)
    schedule: Schedule = Field(default_factory=Schedule)
    client_ids: list[str] = Field(
        default_factory=list, description="Ids SEM namespace (escopados na execução)."
    )
    enabled: bool = True
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    last_run_at: datetime | None = None


# ── Compilação (linguagem natural → AOP) ─────────────────────────────────────

_COMPILER_SYS = (
    "Você compila um procedimento operacional de agentes financeiros descrito em linguagem "
    "natural (português BR). Responda em JSON com: name (título curto), agents (lista, "
    f"apenas dentre: {', '.join(ALLOWED_AGENTS)}), frequency (daily|weekly|monthly), "
    "weekday (0=segunda…6=domingo, se semanal), day (1-28, se mensal), hour (0-23, UTC), "
    "rationale (por que esse plano)."
)

_AGENT_KEYWORDS: dict[str, tuple[str, ...]] = {
    "monitor": ("monitor", "vigi", "acompanh", "alerta"),
    "insight": ("portfólio", "análise", "anomalia", "relatório", "briefing", "concentr"),
    "predictor": ("fluxo de caixa", "projeção", "cenário", "previs"),
    "risk": ("risco", "var", "stress", "rebalance", "volatil"),
    "tax_optimizer": ("tribut", "imposto", "fiscal", "ir ", "harvesting"),
    "researcher": ("notícia", "pesquis", "mercado", "relatórios externos"),
    "strategist": ("planejamento", "longo prazo", "patrimonial", "metas"),
}

_WEEKDAYS = {
    "segunda": 0,
    "terça": 1,
    "terca": 1,
    "quarta": 2,
    "quinta": 3,
    "sexta": 4,
    "sábado": 5,
    "sabado": 5,
    "domingo": 6,
}


class _CompiledAOP(BaseModel):
    """Saída estruturada do compilador."""

    name: str = "Procedimento"
    agents: list[str] = Field(default_factory=list)
    frequency: Frequency = Frequency.WEEKLY
    weekday: int = Field(default=4, ge=0, le=6)
    day: int = Field(default=1, ge=1, le=28)
    hour: int = Field(default=11, ge=0, le=23)
    rationale: str = ""


def _heuristic_compile(text: str) -> _CompiledAOP:
    """Compilação por palavras-chave quando o modelo não está disponível."""
    lowered = text.lower()
    agents = [name for name, kws in _AGENT_KEYWORDS.items() if any(k in lowered for k in kws)]

    frequency = Frequency.WEEKLY
    weekday = 4
    if any(k in lowered for k in ("todo dia", "diária", "diario", "diariamente", "diário")):
        frequency = Frequency.DAILY
    elif any(k in lowered for k in ("todo mês", "mensal", "mensalmente", "fechamento do mês")):
        frequency = Frequency.MONTHLY
    for day_name, idx in _WEEKDAYS.items():
        if day_name in lowered:
            frequency = Frequency.WEEKLY
            weekday = idx
            break

    name = text.strip().splitlines()[0][:60] or "Procedimento"
    return _CompiledAOP(
        name=name,
        agents=agents,
        frequency=frequency,
        weekday=weekday,
        rationale="heurística por keywords",
    )


class AOPCompiler:
    """Traduz a descrição em linguagem natural num :class:`_CompiledAOP`.

    Args:
        router: Router de modelos. ``None`` = só heurística (dev/testes).
    """

    def __init__(self, router: ModelRouter | None = None) -> None:
        self._router = router

    async def compile(self, text: str) -> _CompiledAOP:
        """Compila com o modelo de reasoning; contingência heurística."""
        if self._router is None:
            return _heuristic_compile(text)
        try:
            resp = await self._router.acompletion(
                Role.REASONING,
                messages=[
                    {"role": "system", "content": _COMPILER_SYS},
                    {"role": "user", "content": text},
                ],
                response_format={"type": "json_object"},
            )
            compiled = _CompiledAOP.model_validate_json(resp["choices"][0]["message"]["content"])
            compiled.agents = [a for a in compiled.agents if a in ALLOWED_AGENTS]
            return compiled
        except Exception as exc:  # noqa: BLE001 - contingência: nunca travar
            _log.warning("aop.compile_fallback", error=str(exc))
            return _heuristic_compile(text)


# ── Persistência ─────────────────────────────────────────────────────────────


class AOPStore(abc.ABC):
    """Persistência de AOPs (mutáveis: enable/disable, last_run)."""

    @abc.abstractmethod
    async def save(self, aop: AOP) -> None:
        """Cria ou atualiza um AOP."""

    @abc.abstractmethod
    async def get(self, aop_id: str) -> AOP | None:
        """Retorna um AOP pelo id (ou ``None``)."""

    @abc.abstractmethod
    async def list_for_tenant(self, tenant_id: str) -> list[AOP]:
        """Lista os AOPs de um tenant."""

    @abc.abstractmethod
    async def list_enabled(self) -> list[AOP]:
        """Lista todos os AOPs habilitados (para o scheduler)."""


class InMemoryAOPStore(AOPStore):
    """Store em memória (dev/testes). NÃO persiste entre processos."""

    def __init__(self) -> None:
        self._data: dict[str, AOP] = {}
        self._lock = asyncio.Lock()

    async def save(self, aop: AOP) -> None:
        async with self._lock:
            self._data[aop.id] = aop.model_copy(deep=True)

    async def get(self, aop_id: str) -> AOP | None:
        async with self._lock:
            aop = self._data.get(aop_id)
            return aop.model_copy(deep=True) if aop else None

    async def list_for_tenant(self, tenant_id: str) -> list[AOP]:
        async with self._lock:
            return [
                a.model_copy(deep=True) for a in self._data.values() if a.tenant_id == tenant_id
            ]

    async def list_enabled(self) -> list[AOP]:
        async with self._lock:
            return [a.model_copy(deep=True) for a in self._data.values() if a.enabled]


class FalkorDBAOPStore(AOPStore):
    """Store persistente num grafo dedicado ``carina_aops``."""

    def __init__(self, settings: Settings | None = None, graph_name: str = "carina_aops"):
        self._settings = settings or get_settings()
        self._graph_name = graph_name
        self._graph: Any | None = None

    def _ensure_graph(self) -> Any:
        if self._graph is not None:
            return self._graph
        from falkordb import FalkorDB  # import tardio

        s = self._settings
        s.require_falkordb()
        db = FalkorDB(
            host=s.falkordb_host,
            port=s.falkordb_port,
            username=s.falkordb_username or None,
            password=s.falkordb_password or None,
        )
        self._graph = db.select_graph(self._graph_name)
        return self._graph

    async def save(self, aop: AOP) -> None:
        payload = aop.model_dump_json()

        def _write() -> None:
            graph = self._ensure_graph()
            graph.query(
                "MERGE (a:AOP {id: $id}) "
                "SET a.tenant_id = $tid, a.enabled = $enabled, a.json = $json",
                {"id": aop.id, "tid": aop.tenant_id, "enabled": aop.enabled, "json": payload},
            )

        await asyncio.to_thread(_write)

    async def get(self, aop_id: str) -> AOP | None:
        def _read() -> str | None:
            graph = self._ensure_graph()
            res = graph.query("MATCH (a:AOP {id: $id}) RETURN a.json", {"id": aop_id})
            return res.result_set[0][0] if res.result_set else None

        raw = await asyncio.to_thread(_read)
        return AOP.model_validate_json(raw) if raw else None

    async def list_for_tenant(self, tenant_id: str) -> list[AOP]:
        def _read() -> list[str]:
            graph = self._ensure_graph()
            res = graph.query("MATCH (a:AOP {tenant_id: $tid}) RETURN a.json", {"tid": tenant_id})
            return [row[0] for row in res.result_set]

        rows = await asyncio.to_thread(_read)
        return [AOP.model_validate_json(r) for r in rows]

    async def list_enabled(self) -> list[AOP]:
        def _read() -> list[str]:
            graph = self._ensure_graph()
            res = graph.query("MATCH (a:AOP {enabled: true}) RETURN a.json")
            return [row[0] for row in res.result_set]

        rows = await asyncio.to_thread(_read)
        return [AOP.model_validate_json(r) for r in rows]


# ── Serviço ──────────────────────────────────────────────────────────────────


class AOPService:
    """Cria, agenda e executa AOPs de um ou mais tenants.

    Args:
        store: Persistência dos AOPs. Default: :class:`InMemoryAOPStore`.
        router: Router de modelos (compilação e agentes). ``None`` = heurística.
        metering: Metering das execuções. Default: instância própria (dev).
        watchtower: Auditoria das execuções. Default: instância própria (dev).
    """

    def __init__(
        self,
        store: AOPStore | None = None,
        router: ModelRouter | None = None,
        metering: MeteringService | None = None,
        watchtower: Watchtower | None = None,
    ) -> None:
        self._store = store or InMemoryAOPStore()
        self._router = router
        self._compiler = AOPCompiler(router=router)
        self._metering = metering or MeteringService()
        self._watchtower = watchtower or Watchtower()

    async def create_from_text(
        self,
        *,
        tenant_id: str,
        text: str,
        client_ids: list[str],
        name: str | None = None,
    ) -> AOP:
        """Compila a descrição em linguagem natural e persiste o AOP.

        Raises:
            AOPError: Se nenhum agente válido for identificado na descrição ou
                se algum ``client_id`` for inválido.
        """
        for client_id in client_ids:
            try:
                ensure_valid_client_id(client_id)
            except ValueError as exc:
                raise AOPError(str(exc)) from exc
        compiled = await self._compiler.compile(text)
        if not compiled.agents:
            raise AOPError(
                "Nenhum agente identificado na descrição — mencione o trabalho desejado "
                f"(agentes disponíveis: {', '.join(ALLOWED_AGENTS)})"
            )
        aop = AOP(
            tenant_id=tenant_id,
            name=name or compiled.name,
            description=text,
            agents=compiled.agents,
            schedule=Schedule(
                frequency=compiled.frequency,
                weekday=compiled.weekday,
                day=compiled.day,
                hour=compiled.hour,
            ),
            client_ids=client_ids,
        )
        await self._store.save(aop)
        _log.info("aop.created", aop_id=aop.id, tenant_id=tenant_id, agents=aop.agents)
        return aop

    async def get(self, aop_id: str) -> AOP | None:
        """Retorna um AOP pelo id (ou ``None``)."""
        return await self._store.get(aop_id)

    async def list_for_tenant(self, tenant_id: str) -> list[AOP]:
        """Lista os AOPs de um tenant."""
        return await self._store.list_for_tenant(tenant_id)

    async def set_enabled(self, aop_id: str, enabled: bool) -> AOP:
        """Habilita/desabilita um AOP.

        Raises:
            AOPError: Se o AOP não existir.
        """
        aop = await self._store.get(aop_id)
        if aop is None:
            raise AOPError(f"AOP {aop_id} não encontrado")
        aop.enabled = enabled
        await self._store.save(aop)
        return aop

    async def run(self, aop: AOP) -> dict:
        """Executa o AOP agora para todos os clientes-alvo.

        Para cada cliente: instancia os agentes do procedimento, roda em
        paralelo, registra a resolução no metering e o evento no Watchtower.

        Returns:
            Dict com ``aop_id`` e ``runs`` por cliente (resultados, usage, audit).
        """
        registry = _agent_registry()
        unknown = [a for a in aop.agents if a not in registry]
        if unknown:
            raise AOPError(f"Agentes desconhecidos no AOP {aop.id}: {unknown}")

        tenant = Tenant(id=aop.tenant_id)
        runs: dict[str, Any] = {}
        for client_id in aop.client_ids:
            effective_id = scoped_client_id(tenant, client_id)
            started = time.monotonic()
            results = await self._run_agents(aop, registry, effective_id)
            duration_ms = int((time.monotonic() - started) * 1000)

            usage = await self._metering.record_resolution(
                tenant_id=aop.tenant_id,
                client_id=effective_id,
                agents=aop.agents,
                duration_ms=duration_ms,
            )
            audit = await self._watchtower.review(
                tenant_id=aop.tenant_id,
                client_id=effective_id,
                query=f"[AOP:{aop.name}] {aop.description}",
                results=results,
                channel="aop",
                duration_ms=duration_ms,
            )
            runs[client_id] = {
                "results": results,
                "usage": {"work_type": usage.work_type.value, "price_brl": usage.price_brl},
                "compliance": {
                    "audit_id": audit.id,
                    "flags": [f.model_dump() for f in audit.flags],
                },
            }

        aop.last_run_at = datetime.now(timezone.utc)
        await self._store.save(aop)
        _log.info("aop.ran", aop_id=aop.id, clients=len(runs))
        return {"aop_id": aop.id, "runs": runs}

    async def _run_agents(
        self, aop: AOP, registry: dict[str, type], effective_client_id: str
    ) -> dict[str, Any]:
        """Roda os agentes do AOP em paralelo para um cliente (erros isolados)."""
        instances = []
        for agent_name in aop.agents:
            kwargs = {"router": self._router} if self._router is not None else {}
            instances.append((agent_name, registry[agent_name](effective_client_id, **kwargs)))

        outputs = await asyncio.gather(
            *(
                agent.process(agent.make_msg(f"Execute o procedimento: {aop.description}"))
                for _, agent in instances
            ),
            return_exceptions=True,
        )
        results: dict[str, Any] = {}
        for (agent_name, _), out in zip(instances, outputs):
            if isinstance(out, Exception):
                results[agent_name] = {"error": str(out)}
            else:
                results[agent_name] = getattr(out, "content", out)
        return results

    async def run_due(self, now: datetime | None = None) -> list[dict]:
        """Executa todos os AOPs habilitados cujo disparo agendado venceu.

        Pensado para o job recorrente (Modal). Erros de um AOP não derrubam
        os demais.
        """
        now = now or datetime.now(timezone.utc)
        executed: list[dict] = []
        for aop in await self._store.list_enabled():
            if not aop.schedule.is_due(now, aop.last_run_at):
                continue
            try:
                executed.append(await self.run(aop))
            except Exception as exc:  # noqa: BLE001 - um AOP não derruba o lote
                _log.error("aop.run_failed", aop_id=aop.id, error=str(exc))
        return executed
