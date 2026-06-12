"""Roteamento de modelos por papel, com fallback automático (via LiteLLM).

Como o GraphRAG-SDK e os agentes usam LiteLLM por baixo, o roteamento é por
*string de modelo* + config (``carina/config/models.yaml``). Trocar provedor é
editar o YAML — nunca o código.

Responsabilidades:
  1. Carregar o YAML e resolver, por :class:`~carina.models.roles.Role`, o modelo
     primário e a cadeia de fallback.
  2. Injetar credenciais (NIM/Groq) nas variáveis de ambiente que o LiteLLM
     espera, a partir de :class:`~carina.config.settings.Settings` — sem hardcode.
  3. Entregar objetos do GraphRAG-SDK (``LiteLLM`` / ``LiteLLMEmbedder``) para a
     camada de conhecimento.
  4. Expor :meth:`ModelRouter.acompletion`, que executa uma chamada com fallback
     automático em rate-limit/erro de provedor, logando cada troca.

Embeddings NÃO têm fallback (ver YAML) → cachear agressivamente
(:class:`carina.utils.cache.EmbeddingCache`).
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from carina.config.settings import Settings, get_settings
from carina.models.roles import Role
from carina.utils.errors import AllProvidersFailedError, ConfigError
from carina.utils.logging import get_logger

_log = get_logger(__name__)

_DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config" / "models.yaml"


class ModelRouter:
    """Resolve modelos por papel e executa chamadas com fallback.

    Args:
        settings: Configuração (credenciais). Default: :func:`get_settings`.
        config_path: Caminho do ``models.yaml``. Default: o que estiver em
            ``CARINA_MODELS_CONFIG`` ou o YAML embutido no pacote.
    """

    def __init__(
        self,
        settings: Settings | None = None,
        config_path: str | os.PathLike[str] | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        path = Path(config_path or self._settings.models_config_path or _DEFAULT_CONFIG)
        self._config = self._load_config(path)
        self._roles: dict[str, Any] = self._config.get("roles", {})
        self._litellm_cfg: dict[str, Any] = self._config.get("litellm", {})
        self._export_provider_env()

    # ── carregamento ─────────────────────────────────────────────────────────
    @staticmethod
    def _load_config(path: Path) -> dict[str, Any]:
        if not path.exists():
            raise ConfigError(f"models.yaml não encontrado em {path}")
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as exc:  # pragma: no cover - defensivo
            raise ConfigError(f"models.yaml inválido: {exc}") from exc
        if not isinstance(data, dict) or "roles" not in data:
            raise ConfigError("models.yaml deve conter a chave 'roles'")
        return data

    def _export_provider_env(self) -> None:
        """Mapeia credenciais das Settings para as env vars que o LiteLLM lê.

        LiteLLM resolve credenciais por convenção de env var por provedor. Setamos
        a partir do ``.env`` do CARINA para que tanto o GraphRAG-SDK quanto as
        chamadas diretas funcionem sem repassar segredos manualmente.
        """
        s = self._settings
        if s.openrouter_api_key:
            os.environ.setdefault("OPENROUTER_API_KEY", s.openrouter_api_key)
            os.environ.setdefault("OPENROUTER_API_BASE", s.openrouter_base_url)
        if s.nvidia_api_key:
            os.environ.setdefault("NVIDIA_NIM_API_KEY", s.nvidia_api_key)
            os.environ.setdefault("NVIDIA_NIM_API_BASE", s.nvidia_base_url)
        if s.groq_api_key:
            os.environ.setdefault("GROQ_API_KEY", s.groq_api_key)

    # ── resolução de cadeia ───────────────────────────────────────────────────
    def chain_for(self, role: Role) -> list[str]:
        """Retorna ``[primário, *fallbacks]`` para um papel.

        Args:
            role: Papel desejado.

        Returns:
            Lista ordenada de strings de modelo (LiteLLM) a tentar.

        Raises:
            ConfigError: Se o papel não estiver no YAML ou não tiver ``primary``.
        """
        cfg = self._roles.get(role.value)
        if not cfg or "primary" not in cfg:
            raise ConfigError(f"Papel '{role.value}' sem 'primary' em models.yaml")
        fallback = cfg.get("fallback") or []
        if isinstance(fallback, str):
            fallback = [fallback]
        return [cfg["primary"], *fallback]

    def model_for(self, role: Role) -> str:
        """Modelo primário (string LiteLLM) de um papel."""
        return self.chain_for(role)[0]

    def embedding_dimensions(self) -> int:
        """Dimensão configurada do embedder (para o índice vetorial do FalkorDB)."""
        cfg = self._roles.get(Role.EMBEDDINGS.value, {})
        return int(cfg.get("dimensions", 1024))

    # ── params para AgentScope (OpenAI-compatible) ────────────────────────────
    def openai_params_for(self, role: Role) -> dict[str, Any]:
        """Traduz o modelo primário do papel em params do ``OpenAIChatModel``.

        OpenRouter, NIM e Groq são OpenAI-compatible; o prefixo do provedor na
        string LiteLLM decide o ``base_url`` + ``api_key``. Mantém
        modelo-como-config. No OpenRouter o nome do modelo preserva o caminho
        completo após o prefixo (ex.: ``openai/gpt-oss-120b:free``).

        Args:
            role: Papel desejado.

        Returns:
            Dict com ``model_name``, ``api_key`` e ``base_url`` (este último em
            ``client_args`` no construtor do AgentScope).
        """
        s = self._settings
        model = self.model_for(role)
        provider, _, name = model.partition("/")
        if provider == "openrouter":
            return {
                "model_name": name,
                "api_key": s.openrouter_api_key,
                "base_url": s.openrouter_base_url,
            }
        if provider == "nvidia_nim":
            return {"model_name": name, "api_key": s.nvidia_api_key, "base_url": s.nvidia_base_url}
        if provider == "groq":
            return {"model_name": name, "api_key": s.groq_api_key, "base_url": s.groq_base_url}
        # Sem prefixo reconhecido: assume NIM (embeddings e modelos legados).
        return {"model_name": model, "api_key": s.nvidia_api_key, "base_url": s.nvidia_base_url}

    # ── objetos do GraphRAG-SDK ───────────────────────────────────────────────
    def llm_for(self, role: Role) -> Any:
        """Instancia um ``graphrag_sdk.LiteLLM`` para o modelo primário do papel.

        Usado pela camada de conhecimento e por agentes que querem o objeto do SDK.
        O fallback de provedor para chamadas diretas é feito por :meth:`acompletion`.
        """
        from graphrag_sdk import LiteLLM  # import tardio: dependência pesada

        return LiteLLM(model=self.model_for(role))

    def embedder(self) -> Any:
        """Instancia o ``graphrag_sdk.LiteLLMEmbedder`` (NeMo Retriever, 1024d)."""
        from graphrag_sdk import LiteLLMEmbedder

        return LiteLLMEmbedder(
            model=self.model_for(Role.EMBEDDINGS),
            dimensions=self.embedding_dimensions(),
        )

    # ── chamada direta com fallback ────────────────────────────────────────────
    async def acompletion(
        self,
        role: Role,
        messages: list[dict[str, str]],
        **kwargs: Any,
    ) -> Any:
        """Executa um completion tentando primário → fallbacks em rate-limit/erro.

        Args:
            role: Papel que define a cadeia de modelos.
            messages: Mensagens no formato OpenAI (``[{"role": ..., "content": ...}]``).
            **kwargs: Repassados ao ``litellm.acompletion`` (ex.: ``response_format``,
                ``temperature``, ``tools``).

        Returns:
            A resposta do ``litellm.acompletion`` do primeiro provedor que responder.

        Raises:
            AllProvidersFailedError: Se todos os modelos da cadeia falharem.
        """
        import litellm
        from litellm.exceptions import (
            APIError,
            RateLimitError,
            ServiceUnavailableError,
            Timeout,
        )

        retryable = (RateLimitError, APIError, ServiceUnavailableError, Timeout)
        params = {
            "timeout": self._litellm_cfg.get("timeout", 60),
            "num_retries": self._litellm_cfg.get("max_retries", 2),
            "temperature": self._litellm_cfg.get("temperature", 0.2),
            **kwargs,
        }

        chain = self.chain_for(role)
        last_exc: Exception | None = None
        for idx, model in enumerate(chain):
            try:
                _log.info("router.completion", role=role.value, model=model, attempt=idx)
                return await litellm.acompletion(model=model, messages=messages, **params)
            except retryable as exc:
                last_exc = exc
                _log.warning(
                    "router.fallback",
                    role=role.value,
                    failed_model=model,
                    next_model=chain[idx + 1] if idx + 1 < len(chain) else None,
                    error=str(exc),
                )
                continue

        raise AllProvidersFailedError(
            f"Todos os provedores falharam para o papel '{role.value}': {chain}"
        ) from last_exc


@lru_cache
def get_router() -> ModelRouter:
    """Retorna a instância única (cacheada) do :class:`ModelRouter`."""
    return ModelRouter()
