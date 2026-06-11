"""Agente base do CARINA, sobre o ``ReActAgent`` do AgentScope.

Todo agente CARINA:
  * resolve seu modelo por PAPEL via :class:`~carina.models.router.ModelRouter`
    (modelo-como-config; NIM/Groq são OpenAI-compatible);
  * consulta o grafo isolado do cliente (``client_<id>``);
  * loga toda ação de forma estruturada;
  * segue o molde de system prompt: ``# IDENTIDADE → # CONTEXTO → # TAREFA → # REGRA``.

Saída estruturada: passe ``structured_model`` (subclasse de ``pydantic.BaseModel``)
— o ReActAgent do AgentScope o usa para forçar JSON aderente a schema (ideal para
os agentes de raciocínio com Hermes).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from carina.knowledge.graph import CarinaKnowledge
from carina.knowledge.query import GraphAnswer, query_graph
from carina.models.roles import Role
from carina.models.router import ModelRouter, get_router
from carina.utils.errors import AgentError
from carina.utils.logging import get_logger

# Molde obrigatório de system prompt.
SYSTEM_PROMPT_TEMPLATE = """# IDENTIDADE
{identity}

# CONTEXTO
{context}

# TAREFA
{task}

# REGRA
{rule}"""


def build_system_prompt(*, identity: str, context: str, task: str, rule: str) -> str:
    """Monta um system prompt no molde CARINA.

    Args:
        identity: Quem o agente é.
        context: O ambiente/dados com que opera.
        task: O que deve fazer.
        rule: A regra dura (vai no fim, é a mais aderida).

    Returns:
        System prompt formatado.
    """
    return SYSTEM_PROMPT_TEMPLATE.format(
        identity=identity.strip(),
        context=context.strip(),
        task=task.strip(),
        rule=rule.strip(),
    )


class CarinaBaseAgent:
    """Base de todos os agentes CARINA.

    Encapsula um ``ReActAgent`` do AgentScope construído com o modelo do papel.
    Subclasses definem ``role`` e o system prompt (via :func:`build_system_prompt`)
    e, opcionalmente, sobrescrevem :meth:`process` para orquestração custom.

    Args:
        name: Nome do agente (identificador no AgentScope e nos logs).
        client_id: Cliente que este agente atende (define o grafo consultado).
        role: Papel de modelo (resolve LLM + fallback via router).
        system_prompt: System prompt já no molde CARINA.
        router: Router de modelos. Default: :func:`get_router`.
        knowledge: Camada de conhecimento. Default: nova :class:`CarinaKnowledge`.
        structured_model: Schema Pydantic opcional para saída estruturada.
        tools: Lista opcional de funções-ferramenta para o ReActAgent.
    """

    role: Role = Role.CONVERSATIONAL

    def __init__(
        self,
        name: str,
        client_id: str,
        *,
        role: Role | None = None,
        system_prompt: str,
        router: ModelRouter | None = None,
        knowledge: CarinaKnowledge | None = None,
        structured_model: type[BaseModel] | None = None,
        tools: list[Any] | None = None,
    ) -> None:
        self.name = name
        self.client_id = client_id
        self.role = role or self.role
        self.system_prompt = system_prompt
        self._router = router or get_router()
        self._knowledge = knowledge or CarinaKnowledge(router=self._router)
        self._structured_model = structured_model
        self._tools = tools or []
        self._log = get_logger(self.__class__.__name__).bind(
            agent=name, client_id=client_id, role=self.role.value
        )
        self._agent: Any | None = None  # ReActAgent construído sob demanda

    # ── construção tardia do ReActAgent (dependências pesadas) ────────────────
    def _build_agent(self) -> Any:
        from agentscope.agent import ReActAgent
        from agentscope.formatter import OpenAIChatFormatter
        from agentscope.memory import InMemoryMemory
        from agentscope.model import OpenAIChatModel
        from agentscope.tool import Toolkit

        params = self._router.openai_params_for(self.role)
        model = OpenAIChatModel(
            model_name=params["model_name"],
            api_key=params["api_key"],
            client_args={"base_url": params["base_url"]},
            stream=False,
        )
        toolkit = Toolkit()
        for tool in self._tools:
            toolkit.register_tool_function(tool)

        kwargs: dict[str, Any] = {
            "name": self.name,
            "sys_prompt": self.system_prompt,
            "model": model,
            "formatter": OpenAIChatFormatter(),
            "memory": InMemoryMemory(),
            "toolkit": toolkit,
        }
        if self._structured_model is not None:
            kwargs["structured_model"] = self._structured_model
        return ReActAgent(**kwargs)

    @property
    def agent(self) -> Any:
        """O ``ReActAgent`` subjacente (construído na primeira utilização)."""
        if self._agent is None:
            self._agent = self._build_agent()
            self._log.info("agent.built", model=self._router.model_for(self.role))
        return self._agent

    # ── API pública ───────────────────────────────────────────────────────────
    async def process(self, msg: Any) -> Any:
        """Processa uma mensagem e retorna a resposta do agente.

        Args:
            msg: ``agentscope.message.Msg`` de entrada (ou objeto compatível).

        Returns:
            ``Msg`` de resposta do agente.

        Raises:
            AgentError: Em falha durante o processamento.
        """
        try:
            self._log.info("agent.process")
            return await self.agent(msg)
        except Exception as exc:  # noqa: BLE001 - fronteira
            self._log.error("agent.process_failed", error=str(exc))
            raise AgentError(f"{self.name} falhou ao processar: {exc}") from exc

    async def aquery_graph(self, question: str) -> GraphAnswer:
        """Consulta o grafo do cliente deste agente (com trilha de citação).

        Args:
            question: Pergunta em linguagem natural.

        Returns:
            :class:`~carina.knowledge.query.GraphAnswer` (resposta + contexto).
        """
        self._log.info("agent.query_graph")
        return await query_graph(self._knowledge, self.client_id, question)

    @staticmethod
    def make_msg(content: str, *, name: str = "user", role: str = "user") -> Any:
        """Helper para criar um ``agentscope.message.Msg``.

        AgentScope 2.x exige ``content`` como lista de blocos; 1.x aceita str.
        """
        from agentscope.message import Msg

        try:
            return Msg(name=name, content=content, role=role)
        except Exception:  # noqa: BLE001 - compat 2.x (content em blocos)
            return Msg(name=name, content=[{"type": "text", "text": content}], role=role)
