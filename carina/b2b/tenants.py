"""Tenants B2B e chaves de API.

Cada cliente B2B (banco, fintech, gestora) é um *tenant* identificado por uma
chave de API. O isolamento é estrutural: todo ``client_id`` recebido na API é
prefixado com o id do tenant (``{tenant_id}__{client_id}``), de modo que o grafo
de conhecimento, a inbox e o metering de um tenant nunca colidem com os de outro
— mesmo que dois tenants usem o mesmo ``client_id`` interno.

As chaves vêm da variável ``CARINA_API_KEYS`` no formato::

    sk-live-abc:acme:Acme Fintech;sk-live-def:warren:Warren

Apenas o hash SHA-256 das chaves fica em memória após o parse. Sem chaves
configuradas, o comportamento depende do ambiente: em desenvolvimento existe um
tenant ``dev`` implícito (para não quebrar o fluxo local); em produção a API
falha fechada (nenhuma requisição autenticada).
"""

from __future__ import annotations

import hashlib
import hmac

from pydantic import BaseModel, Field

from carina.config.settings import Settings, get_settings
from carina.utils.logging import get_logger

_log = get_logger(__name__)

#: Separador entre tenant e client_id no id efetivo (escolhido para não colidir
#: com ids comuns e permitir checagem de posse por prefixo).
_SCOPE_SEP = "__"

_DEV_TENANT_ID = "dev"


class Tenant(BaseModel):
    """Cliente B2B autenticado por chave de API."""

    id: str = Field(min_length=1, description="Identificador único do tenant.")
    name: str = Field(default="", description="Nome de exibição.")
    plan: str = Field(default="standard", description="Plano comercial (informativo).")


def scoped_client_id(tenant: Tenant, client_id: str) -> str:
    """Retorna o ``client_id`` efetivo, isolado no namespace do tenant."""
    return f"{tenant.id}{_SCOPE_SEP}{client_id}"


def owns_client(tenant: Tenant, effective_client_id: str) -> bool:
    """``True`` se o ``client_id`` efetivo pertence ao namespace do tenant."""
    return effective_client_id.startswith(f"{tenant.id}{_SCOPE_SEP}")


def _hash_key(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


class ApiKeyStore:
    """Resolve chaves de API em tenants (hashes em memória).

    Args:
        settings: Configuração (lê ``CARINA_API_KEYS``). Default: :func:`get_settings`.
    """

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()
        self._by_hash: dict[str, Tenant] = {}
        self._parse(self._settings.carina_api_keys)

    def _parse(self, raw: str) -> None:
        for entry in filter(None, (e.strip() for e in raw.split(";"))):
            parts = entry.split(":", 2)
            if len(parts) < 2 or not parts[0] or not parts[1]:
                _log.warning("apikeys.entry_invalid", entry_prefix=entry[:8])
                continue
            key, tenant_id = parts[0], parts[1]
            name = parts[2] if len(parts) == 3 else tenant_id
            self._by_hash[_hash_key(key)] = Tenant(id=tenant_id, name=name)
        _log.info("apikeys.loaded", tenants=len(self._by_hash))

    @property
    def has_keys(self) -> bool:
        """``True`` quando há pelo menos uma chave configurada."""
        return bool(self._by_hash)

    def resolve(self, key: str | None) -> Tenant | None:
        """Resolve uma chave apresentada em um :class:`Tenant` (ou ``None``).

        Sem chaves configuradas: em dev retorna o tenant ``dev`` implícito;
        em produção retorna ``None`` (falha fechada).
        """
        if not self.has_keys:
            if self._settings.is_production:
                return None
            return Tenant(id=_DEV_TENANT_ID, name="Desenvolvimento local")
        if not key:
            return None
        digest = _hash_key(key)
        for stored_hash, tenant in self._by_hash.items():
            if hmac.compare_digest(stored_hash, digest):
                return tenant
        return None
