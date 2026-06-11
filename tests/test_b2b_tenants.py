"""Testes de tenants e chaves de API B2B (sem serviços externos)."""

from __future__ import annotations

import pytest

from carina.b2b.tenants import (
    ApiKeyStore,
    Tenant,
    ensure_valid_client_id,
    owns_client,
    scoped_client_id,
)
from carina.config.settings import Settings


def _settings(keys: str = "", env: str = "test", allow_dev: bool = False) -> Settings:
    return Settings(CARINA_API_KEYS=keys, CARINA_ENV=env, CARINA_ALLOW_DEV_TENANT=allow_dev)


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


def test_tenant_id_com_separador_e_descartado():
    # 'acme__staging' colidiria com o client 'staging*' do tenant 'acme'.
    store = ApiKeyStore(settings=_settings("sk-x:acme__staging:Staging;sk-ok:acme"))
    assert store.resolve("sk-x") is None
    assert store.resolve("sk-ok") is not None


def test_dev_sem_chaves_exige_opt_in_explicito():
    # Sem o opt-in, dev também falha fechado.
    store = ApiKeyStore(settings=_settings(keys="", env="dev"))
    assert store.resolve(None) is None

    opted_in = ApiKeyStore(settings=_settings(keys="", env="dev", allow_dev=True))
    tenant = opted_in.resolve(None)
    assert tenant is not None
    assert tenant.id == "dev"


def test_producao_sem_chaves_falha_fechada_mesmo_com_opt_in():
    store = ApiKeyStore(settings=_settings(keys="", env="production", allow_dev=True))
    assert store.resolve(None) is None
    assert store.resolve("qualquer") is None


def test_escopo_de_client_id_por_tenant():
    acme = Tenant(id="acme")
    warren = Tenant(id="warren")
    effective = scoped_client_id(acme, "cliente-1")
    assert effective == "acme__cliente-1"
    assert owns_client(acme, effective)
    assert not owns_client(warren, effective)


def test_client_id_com_separador_e_rejeitado():
    # 'staging__victim' produziria 'acme__staging__victim', colidindo com o
    # namespace de um hipotético tenant 'acme__staging'.
    with pytest.raises(ValueError, match="__"):
        scoped_client_id(Tenant(id="acme"), "staging__victim")
    with pytest.raises(ValueError, match="__"):
        ensure_valid_client_id("a__b")
