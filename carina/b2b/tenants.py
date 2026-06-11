"""Tenants B2B e chaves de API.

Cada cliente B2B (banco, fintech, gestora) é um *tenant* identificado por uma
chave de API. O isolamento é estrutural: todo ``client_id`` recebido na API é
prefixado com o id do tenant (``{tenant_id}__{client_id}``), de modo que o grafo
de conhecimento, a inbox e o metering de um tenant nunca colidem com os de outro
— mesmo que dois tenants usem o mesmo ``client_id`` interno.

As chaves vêm da variável ``CARINA_API_KEYS`` no formato::

    sk-live-abc:acme:Acme Fintech;sk-live-def:warren:Warren

Apenas o hash SHA-256 das chaves fica em memória após o parse. Sem chaves
configuradas, a API só atende quando o ambiente é de desenvolvimento E
``CARINA_ALLOW_DEV_TENANT=1`` (tenant ``dev`` implícito, opt-in explícito);
em qualquer outro caso a API falha fechada (nenhuma requisição autenticada).

O isolamento depende do separador ``__``: por isso ele é PROIBIDO tanto em
``client_id`` (validado em :func:`scoped_client_id`) quanto em tenant ids
(entradas inválidas de ``CARINA_API_KEYS`` são descartadas no parse). Com o
separador banido das duas pontas, todo id efetivo tem exatamente um ``__`` e
colisões de namespace são impossíveis por construção.
"""

from __future__ import annotations

import hashlib
import hmac

from pydantic import BaseModel, Field

from carina.config.settings import Settings, get_settings
from carina.utils.logging import get_logger

_log = get_logger(__name__)

#: Separador entre tenant e client_id no id efetivo. Proibido dentro de
#: tenant ids e client_ids — é o que garante a unicidade do namespace.
_SCOPE_SEP = "__"

_DEV_TENANT_ID = "dev"


class Tenant(BaseModel):
    """Cliente B2B autenticado por chave de API."""

    id: str = Field(min_length=1, description="Identificador único do tenant.")
    name: str = Field(default="", description="Nome de exibição.")
    plan: str = Field(default="standard", description="Plano comercial (informativo).")


def ensure_valid_client_id(client_id: str) -> None:
    """Valida um ``client_id`` vindo da API.

    Raises:
        ValueError: Se contiver o separador de namespace ``__``.
    """
    if _SCOPE_SEP in client_id:
        raise ValueError(f"client_id não pode conter '{_SCOPE_SEP}' (separador de namespace)")


def scoped_client_id(tenant: Tenant, client_id: str) -> str:
    """Retorna o ``client_id`` efetivo, isolado no namespace do tenant.

    Raises:
        ValueError: Se ``client_id`` contiver o separador ``__``.
    """
    ensure_valid_client_id(client_id)
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
            if _SCOPE_SEP in tenant_id:
                # '__' quebraria a unicidade do namespace (tenant 'a__b' colide
                # com o client 'b' do tenant 'a') — entrada descartada.
                _log.warning("apikeys.tenant_id_invalid", tenant_id=tenant_id)
                continue
            name = parts[2] if len(parts) == 3 else tenant_id
            self._by_hash[_hash_key(key)] = Tenant(id=tenant_id, name=name)
        _log.info("apikeys.loaded", tenants=len(self._by_hash))

    @property
    def has_keys(self) -> bool:
        """``True`` quando há pelo menos uma chave configurada."""
        return bool(self._by_hash)

    def resolve(self, key: str | None) -> Tenant | None:
        """Resolve uma chave apresentada em um :class:`Tenant` (ou ``None``).

        Sem chaves configuradas: falha fechada, EXCETO quando o ambiente é de
        desenvolvimento e ``CARINA_ALLOW_DEV_TENANT=1`` (opt-in explícito do
        tenant ``dev`` implícito).
        """
        if not self.has_keys:
            if self._settings.is_production or not self._settings.carina_allow_dev_tenant:
                return None
            return Tenant(id=_DEV_TENANT_ID, name="Desenvolvimento local")
        if not key:
            return None
        digest = _hash_key(key)
        for stored_hash, tenant in self._by_hash.items():
            if hmac.compare_digest(stored_hash, digest):
                return tenant
        return None
