"""Hierarquia de exceções do CARINA.

Exceções específicas permitem ``try/except`` granular nas fronteiras (router,
knowledge, inbox) e log estruturado consistente.
"""

from __future__ import annotations


class CarinaError(Exception):
    """Erro base de toda a aplicação CARINA."""


class ConfigError(CarinaError):
    """Configuração inválida ou ausente (env var, YAML, schema)."""


class ModelRoutingError(CarinaError):
    """Falha ao resolver/instanciar um modelo para um papel."""


class AllProvidersFailedError(ModelRoutingError):
    """Todos os provedores da cadeia (primário + fallbacks) falharam."""


class KnowledgeError(CarinaError):
    """Falha em operação de conhecimento (ingest/query/finalize/grafo)."""


class InboxError(CarinaError):
    """Falha no fluxo de aprovação (agentic-inbox)."""


class ApprovalRequiredError(InboxError):
    """Ação irreversível exige aprovação humana e não foi aprovada."""


class AgentError(CarinaError):
    """Falha no processamento de um agente."""


class AOPError(CarinaError):
    """Falha em um Agent Operating Procedure (compilação, validação ou execução)."""


class IntegrationError(CarinaError):
    """Falha em integração externa (Open Finance, notificações)."""
