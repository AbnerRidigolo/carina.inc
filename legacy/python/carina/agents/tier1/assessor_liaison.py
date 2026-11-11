"""Assessor Liaison — interage com assessor humano e ingere conhecimento no grafo (Tier 1)."""

from __future__ import annotations

from carina.agents.base_agent import CarinaBaseAgent, build_system_prompt
from carina.knowledge.ingest import Document, ingest_documents
from carina.models.roles import Role

_IDENTITY = (
    "Você é o Assessor Liaison do CARINA, a ponte entre o sistema e o assessor humano "
    "(banco/corretora) do cliente HNWI."
)
_CONTEXT = (
    "Você formula perguntas ao assessor (via WhatsApp/e-mail), extrai o conhecimento das "
    "respostas e o ingere no grafo do cliente (entidade Assessor, relação USES_ASSESSOR)."
)
_TASK = (
    "Gere perguntas claras ao assessor, interprete as respostas e estruture o conhecimento "
    "para ingestão, citando o assessor como fonte."
)
_RULE = (
    "Nunca compartilhe dados do cliente além do necessário para a pergunta. Registre sempre a "
    "origem (qual assessor, quando) para auditoria."
)


class AssessorLiaison(CarinaBaseAgent):
    """Comunicação com o assessor humano e ingestão do conhecimento."""

    role = Role.CONVERSATIONAL

    def __init__(self, client_id: str, **kwargs) -> None:
        super().__init__(
            name="AssessorLiaison",
            client_id=client_id,
            role=Role.CONVERSATIONAL,
            system_prompt=build_system_prompt(
                identity=_IDENTITY, context=_CONTEXT, task=_TASK, rule=_RULE
            ),
            **kwargs,
        )

    async def ingest_assessor_knowledge(self, assessor: str, knowledge_text: str) -> int:
        """Ingere no grafo o conhecimento extraído de um assessor.

        Args:
            assessor: Identificação do assessor (fonte/auditoria).
            knowledge_text: Texto do conhecimento extraído.

        Returns:
            Número de documentos ingeridos (1).
        """
        doc_id = f"assessor::{assessor}"
        self._log.info("assessor_liaison.ingest", assessor=assessor)
        return await ingest_documents(
            self._knowledge,
            self.client_id,
            [Document(document_id=doc_id, text=knowledge_text, metadata={"assessor": assessor})],
        )
