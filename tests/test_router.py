"""Testes do ModelRouter: resolução de cadeia, params OpenAI e fallback."""

from __future__ import annotations

import pytest

from carina.models.roles import Role
from carina.models.router import ModelRouter
from carina.utils.errors import AllProvidersFailedError, ConfigError


def test_chain_includes_primary_and_fallbacks(router: ModelRouter) -> None:
    chain = router.chain_for(Role.CONVERSATIONAL)
    assert chain[0].startswith("nvidia_nim/")
    assert any(m.startswith("groq/") for m in chain[1:]), "fallback Groq esperado"


def test_reasoning_has_multi_step_fallback(router: ModelRouter) -> None:
    chain = router.chain_for(Role.REASONING)
    assert len(chain) >= 2, "reasoning deve ter ao menos um fallback"


def test_embedding_dimensions(router: ModelRouter) -> None:
    assert router.embedding_dimensions() == 1024


def test_openai_params_resolves_provider(router: ModelRouter) -> None:
    params = router.openai_params_for(Role.CONVERSATIONAL)
    assert not params["model_name"].startswith("nvidia_nim"), "prefixo de provedor removido"
    assert "integrate.api.nvidia.com" in params["base_url"]
    assert params["api_key"] == "nvapi-test"


def test_missing_role_raises(router: ModelRouter) -> None:
    router._roles.pop("conversational")  # simula papel ausente no YAML
    with pytest.raises(ConfigError):
        router.chain_for(Role.CONVERSATIONAL)


@pytest.mark.asyncio
async def test_fallback_triggers_on_rate_limit(router: ModelRouter, monkeypatch) -> None:
    """Primário estoura rate-limit → router cai para o fallback e retorna a resposta."""
    import litellm
    from litellm.exceptions import RateLimitError

    calls: list[str] = []

    async def fake_acompletion(model: str, messages, **kwargs):  # type: ignore[no-untyped-def]
        calls.append(model)
        if model == router.model_for(Role.CONVERSATIONAL):
            raise RateLimitError(message="429", model=model, llm_provider="nvidia_nim")
        return {"answer": "ok", "model": model}

    monkeypatch.setattr(litellm, "acompletion", fake_acompletion)

    result = await router.acompletion(
        Role.CONVERSATIONAL, messages=[{"role": "user", "content": "oi"}]
    )
    assert result["answer"] == "ok"
    assert len(calls) == 2, "deve ter tentado primário e depois fallback"


@pytest.mark.asyncio
async def test_all_providers_fail_raises(router: ModelRouter, monkeypatch) -> None:
    import litellm
    from litellm.exceptions import RateLimitError

    async def always_fail(model: str, messages, **kwargs):  # type: ignore[no-untyped-def]
        raise RateLimitError(message="429", model=model, llm_provider="x")

    monkeypatch.setattr(litellm, "acompletion", always_fail)

    with pytest.raises(AllProvidersFailedError):
        await router.acompletion(Role.CONVERSATIONAL, messages=[{"role": "user", "content": "oi"}])
