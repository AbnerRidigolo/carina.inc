"""Settings da aplicação, carregadas de variáveis de ambiente / ``.env``.

Nenhum segredo tem default — credenciais ausentes falham cedo e explicitamente.
Use :func:`get_settings` (cacheado) em todo o código; nunca leia ``os.environ``
diretamente para credenciais.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuração central do CARINA (fronteira de credenciais)."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── NVIDIA NIM (primário) ────────────────────────────────────────────────
    nvidia_api_key: str = Field(default="", alias="NVIDIA_API_KEY")
    nvidia_base_url: str = Field(
        default="https://integrate.api.nvidia.com/v1", alias="NVIDIA_BASE_URL"
    )

    # ── Groq (fallback) ──────────────────────────────────────────────────────
    groq_api_key: str = Field(default="", alias="GROQ_API_KEY")
    groq_base_url: str = Field(default="https://api.groq.com/openai/v1", alias="GROQ_BASE_URL")

    # ── FalkorDB Cloud ───────────────────────────────────────────────────────
    falkordb_host: str = Field(default="", alias="FALKORDB_HOST")
    falkordb_port: int = Field(default=6379, alias="FALKORDB_PORT")
    falkordb_username: str = Field(default="", alias="FALKORDB_USERNAME")
    falkordb_password: str = Field(default="", alias="FALKORDB_PASSWORD")

    # ── Operacional ──────────────────────────────────────────────────────────
    carina_env: str = Field(default="dev", alias="CARINA_ENV")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    # ── B2B (chaves de API por tenant) ──────────────────────────────────────
    # Formato: "chave:tenant_id:Nome do Tenant;chave2:tenant2". Tenant ids não
    # podem conter "__" (separador de namespace). Sem chaves: falha fechada,
    # exceto em dev com CARINA_ALLOW_DEV_TENANT=1 (tenant implícito).
    carina_api_keys: str = Field(default="", alias="CARINA_API_KEYS")
    carina_allow_dev_tenant: bool = Field(default=False, alias="CARINA_ALLOW_DEV_TENANT")

    # ── B2B (rate limiting e quotas) ────────────────────────────────────────
    # Overrides por tenant: "tenant:rpm:resoluções_mês;tenant2:rpm". Quota 0 =
    # ilimitada. Tenants ausentes usam os defaults abaixo.
    carina_tenant_limits: str = Field(default="", alias="CARINA_TENANT_LIMITS")
    carina_default_rpm: int = Field(default=60, alias="CARINA_DEFAULT_RPM")
    carina_default_monthly_quota: int = Field(default=0, alias="CARINA_DEFAULT_MONTHLY_QUOTA")

    # ── B2B (precificação) ──────────────────────────────────────────────────
    # Fee sobre o valor movimentado em execuções aprovadas, em % (0.5 = 0,5%).
    # Soma-se ao preço base da resolução EXECUTION (tabela de docs/B2B.md).
    carina_execution_fee_pct: float = Field(default=0.5, alias="CARINA_EXECUTION_FEE_PCT")

    # ── Data Engine — Camada 1 (Market Data BR) ─────────────────────────────
    # brapi.dev (cotações/histórico B3) — token opcional, free tier sem ele.
    brapi_token: str = Field(default="", alias="BRAPI_TOKEN")
    brapi_base_url: str = Field(default="https://brapi.dev/api", alias="BRAPI_BASE_URL")
    # SGS do Banco Central (macro) — API pública, sem chave.
    bcb_base_url: str = Field(default="https://api.bcb.gov.br", alias="BCB_BASE_URL")
    models_config_path: str = Field(default="", alias="CARINA_MODELS_CONFIG")
    embedding_cache_dir: str = Field(default=".carina_cache", alias="CARINA_EMBEDDING_CACHE_DIR")

    # ── Integrações (opcionais até F3/F4) ────────────────────────────────────
    # Open Finance via agregador (atual: Pluggy — credenciais do dashboard).
    open_finance_client_id: str = Field(default="", alias="OPEN_FINANCE_CLIENT_ID")
    open_finance_client_secret: str = Field(default="", alias="OPEN_FINANCE_CLIENT_SECRET")
    open_finance_base_url: str = Field(
        default="https://api.pluggy.ai", alias="OPEN_FINANCE_BASE_URL"
    )
    whatsapp_token: str = Field(default="", alias="WHATSAPP_TOKEN")
    smtp_host: str = Field(default="", alias="SMTP_HOST")
    smtp_user: str = Field(default="", alias="SMTP_USER")
    smtp_password: str = Field(default="", alias="SMTP_PASSWORD")

    @property
    def is_production(self) -> bool:
        """``True`` quando rodando fora do ambiente de desenvolvimento."""
        return self.carina_env.lower() not in {"dev", "development", "local", "test"}

    def require_nvidia(self) -> None:
        """Valida que a credencial do NIM está presente (chamar antes de usar)."""
        if not self.nvidia_api_key:
            raise ValueError("NVIDIA_API_KEY ausente — configure no .env")

    def require_falkordb(self) -> None:
        """Valida que a conexão do FalkorDB Cloud está presente."""
        if not self.falkordb_host:
            raise ValueError("FALKORDB_HOST ausente — configure no .env")


@lru_cache
def get_settings() -> Settings:
    """Retorna a instância única (cacheada) de :class:`Settings`."""
    return Settings()
