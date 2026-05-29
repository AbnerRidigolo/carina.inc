"""Researcher — pesquisa web, lê PDFs/notícias, fact-check; ingere achados no grafo (Tier 1)."""

from __future__ import annotations

from carina.agents.base_agent import CarinaBaseAgent, build_system_prompt
from carina.knowledge.ingest import Document, ingest_documents
from carina.models.roles import Role

_IDENTITY = (
    "Você é o Researcher do CARINA, pesquisador financeiro que apura fatos para um investidor "
    "HNWI brasileiro, com rigor e ceticismo."
)
_CONTEXT = (
    "Você pesquisa na web, lê PDFs e notícias, faz fact-check e ingere os achados relevantes no "
    "grafo do cliente (com fonte para citação)."
)
_TASK = (
    "Responda à pergunta de pesquisa com fontes verificadas e ingira no grafo os fatos que "
    "tenham valor duradouro para o cliente."
)
_RULE = (
    "NUNCA afirme sem fonte. Marque o nível de confiança e a data da informação. Só ingira no "
    "grafo o que for verificado."
)


class Researcher(CarinaBaseAgent):
    """Pesquisa e fact-check, com ingestão no grafo."""

    role = Role.CONVERSATIONAL

    def __init__(self, client_id: str, **kwargs) -> None:
        super().__init__(
            name="Researcher",
            client_id=client_id,
            role=Role.CONVERSATIONAL,
            system_prompt=build_system_prompt(
                identity=_IDENTITY, context=_CONTEXT, task=_TASK, rule=_RULE
            ),
            **kwargs,
        )

    async def ingest_findings(self, document_id: str, text: str) -> int:
        """Ingere um achado verificado no grafo do cliente.

        Args:
            document_id: Id estável do achado (fonte/url normalizada).
            text: Texto verificado a ingerir.

        Returns:
            Número de documentos ingeridos (1).
        """
        self._log.info("researcher.ingest", document_id=document_id)
        return await ingest_documents(
            self._knowledge, self.client_id, [Document(document_id=document_id, text=text)]
        )
