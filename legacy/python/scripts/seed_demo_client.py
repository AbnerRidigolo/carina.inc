"""Popula o grafo de um cliente de demonstração (exige credenciais reais).

    python scripts/seed_demo_client.py [client_id]

Ingere alguns documentos no grafo ``client_<id>`` e roda uma consulta de validação
com trilha de citação.
"""

from __future__ import annotations

import asyncio
import sys

from carina.knowledge.graph import CarinaKnowledge
from carina.knowledge.ingest import Document, ingest_documents
from carina.knowledge.query import query_graph
from carina.utils.logging import configure_logging

_DOCS = [
    Document(
        document_id="perfil",
        text="Carlos Mendes, investidor HNWI, perfil moderado, objetivo de aposentadoria em 20 anos.",
    ),
    Document(
        document_id="posicoes",
        text="Carlos detém PETR4 (energia), ITUB4 (financeiro) e Tesouro IPCA+ 2035.",
    ),
]


async def main(client_id: str) -> None:
    configure_logging(json_logs=False)
    kb = CarinaKnowledge()
    n = await ingest_documents(kb, client_id, _DOCS)
    print(f"Ingeridos {n} documentos em client_{client_id}.")
    ans = await query_graph(kb, client_id, "Quais ativos Carlos possui e em que setores?")
    print("\nResposta:\n", ans.answer)
    print("\nContexto (citação):\n", ans.context)


if __name__ == "__main__":
    cid = sys.argv[1] if len(sys.argv) > 1 else "demo"
    asyncio.run(main(cid))
