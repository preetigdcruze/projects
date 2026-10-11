from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All configuration comes from environment variables (prefix AI_). Secrets are never logged or returned."""

    model_config = SettingsConfigDict(env_prefix="AI_", env_file=".env", extra="ignore")

    # service
    internal_token: SecretStr = SecretStr("dev-ai-internal-token")  # shared with the backend; callers must present it
    backend_url: str = "http://localhost:8080"
    backend_service_token: SecretStr = SecretStr("dev-service-token")  # lets the detector persist anomalies
    backend_timeout_seconds: float = 5.0
    max_request_bytes: int = 32_768
    rate_limit_per_minute: int = 120
    environment: Literal["development", "production"] = "development"

    # provider selection: mock (default, deterministic, no network) | anthropic | openai_compatible
    provider: Literal["mock", "anthropic", "openai_compatible"] = "mock"
    model: str = "claude-sonnet-5-5"
    api_key: SecretStr | None = None
    api_base_url: str | None = None  # required for openai_compatible; optional override for anthropic
    provider_timeout_seconds: float = 30.0
    provider_max_retries: int = 2
    provider_backoff_seconds: float = 0.5
    max_output_tokens: int = 1200

    # prompt budget
    max_context_chars: int = 14_000
    max_evidence_items: int = 60
    max_untrusted_chars: int = 300

    # anomaly detection defaults (overridable per request within validated bounds)
    anomaly_window: int = Field(24, ge=6, le=168)
    anomaly_min_baseline_points: int = Field(8, ge=4)

    @field_validator("backend_url", "api_base_url")
    @classmethod
    def _strip_slash(cls, v: str | None) -> str | None:
        return v.rstrip("/") if v else v

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
