from __future__ import annotations

import httpx

from ..config import Settings
from .base import LLMProvider, ProviderError, ProviderStats, RedactingProvider, ResilientProvider
from .http_providers import AnthropicProvider, OpenAICompatibleProvider, UnavailableProvider
from .mock import MockProvider


def build_provider(settings: Settings, stats: ProviderStats, client: httpx.Client | None = None) -> LLMProvider:
    """Selects the provider from configuration and wraps it with redaction (outer) and retries (inner).

    A real provider that is misconfigured becomes UnavailableProvider; we never silently fall back to the mock, because
    that would present canned text as a real model answer.
    """
    key = settings.api_key.get_secret_value() if settings.api_key else None
    inner: LLMProvider
    if settings.provider == "mock":
        inner = MockProvider()
    elif settings.provider == "anthropic":
        inner = AnthropicProvider(settings.model, key, settings.api_base_url, settings.provider_timeout_seconds, client)
    else:
        try:
            inner = OpenAICompatibleProvider(settings.model, key, settings.api_base_url, settings.provider_timeout_seconds, client)
        except ProviderError as e:
            inner = UnavailableProvider("openai_compatible", settings.model, str(e))
    if settings.provider != "mock" and not inner.configured() and not isinstance(inner, UnavailableProvider):
        inner = UnavailableProvider(inner.name, settings.model, "no API key configured (set AI_API_KEY)")
    resilient = ResilientProvider(inner, stats, settings.provider_max_retries, settings.provider_backoff_seconds)
    return RedactingProvider(resilient)
