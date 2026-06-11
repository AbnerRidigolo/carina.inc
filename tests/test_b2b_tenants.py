"""Testes de tenants e chaves de API B2B (sem serviços externos)."""

from __future__ import annotations

from carina.b2b.tenants import ApiKeyStore, Tenant, owns_client, scoped_client_id
from carina.config.settings import Settings


def _settings(keys: str = "", env: str = "test") -> Settings:
    return Settings(CARINA_API_KEYS=keys, CARINA_ENV=env)


def test_parse_e_resolve_chave_valida():
    store = ApiKeyStore(settings=_settings("sk-abc:acme:Acme Fintech;sk-def:warren"))
    tenant = store.resolve("sk-abc")
    assert tenant is not None
    assert tenant.id == "acme"
    assert tenant.name == "Acme Fintech"
    # Nome default = id quando omitido.
    assert store.resolve("sk-def").name == "warren"


def test_chave_invalida_retorna_none():
    store = ApiKeyStore(settings=_settings("sk-abc:acme"))
    assert store.resolve("sk-errada") is None
    assert store.resolve(None) is None
    assert store.resolve("") is None


def test_entrada_malformada_e_ignorada():
    store = ApiKeyStore(settings=_settings("semseparador;sk-ok:acme"))
    assert store.resolve("semseparador") is None
    assert store.resolve("sk-ok") is not None


def test_dev_sem_chaves_usa_tenant_implicito():
    store = ApiKeyStore(settings=_settings(keys="", env="dev"))
    tenant = store.resolve(None)
    assert tenant is not None
    assert tenant.id == "dev"


def test_producao_sem_chaves_falha_fechada():
    store = ApiKeyStore(settings=_settings(keys="", env="production"))
    assert store.resolve(None) is None
    assert store.resolve("qualquer") is None


def test_escopo_de_client_id_por_tenant():
    acme = Tenant(id="acme")
    warren = Tenant(id="warren")
    effective = scoped_client_id(acme, "cliente-1")
    assert effective == "acme__cliente-1"
    assert owns_client(acme, effective)
    assert not owns_client(warren, effective)
