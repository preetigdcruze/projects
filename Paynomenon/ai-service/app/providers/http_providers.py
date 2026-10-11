"""Adapters for real LLM APIs. Plain HTTPS via httpx: no vendor SDK, so behaviour and error mapping are explicit."""

from __future__ import annotations

import time

import httpx

from .base import (
    LLMProvider,
    LLMRequest,
    LLMResponse,
    ProviderAuthError,
    ProviderBadRequest,
    ProviderInvalidResponse,
    ProviderNotConfigured,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
)


def _retry_after(resp: httpx.Response) -> float | None:
    raw = resp.headers.get("retry-after")
    try:
        return float(raw) if raw else None
    except ValueError:
        return None


def _raise_for(resp: httpx.Response) -> None:
    code = resp.status_code
    if code < 400:
        return
    if code == 429:
        raise ProviderRateLimited("rate limited by provider", _retry_after(resp))
    if code in (401, 403):
        raise ProviderAuthError(f"provider rejected credentials (HTTP {code})")
    if code in (408, 504):
        raise ProviderTimeout(f"provider gateway timeout (HTTP {code})")
    if code >= 500 or code == 529:  # 529: overloaded
        raise ProviderUnavailable(f"provider unavailable (HTTP {code})", _retry_after(resp))
    raise ProviderBadRequest(f"provider rejected the request (HTTP {code})")


class _HttpProvider(LLMProvider):
    def __init__(self, model: str, api_key: str | None, base_url: str, timeout: float, client: httpx.Client | None = None):
        self.model, self._key, self._base = model, api_key, base_url.rstrip("/")
        self._client = client or httpx.Client(timeout=httpx.Timeout(timeout, connect=min(timeout, 5.0)))

    def configured(self) -> bool:
        return bool(self._key)

    def _post(self, url: str, headers: dict, body: dict) -> dict:
        if not self._key:
            raise ProviderNotConfigured("no API key configured (set AI_API_KEY)")
        try:
            resp = self._client.post(url, headers=headers, json=body)
        except httpx.TimeoutException as e:
            raise ProviderTimeout("provider request timed out") from e
        except httpx.HTTPError as e:
            raise ProviderUnavailable(f"provider unreachable: {type(e).__name__}") from e
        _raise_for(resp)
        try:
            return resp.json()
        except ValueError as e:
            raise ProviderInvalidResponse("provider returned non-JSON body") from e


class AnthropicProvider(_HttpProvider):
    name = "anthropic"

    def __init__(self, model: str, api_key: str | None, base_url: str | None, timeout: float, client: httpx.Client | None = None):
        super().__init__(model, api_key, base_url or "https://api.anthropic.com", timeout, client)

    def complete(self, request: LLMRequest) -> LLMResponse:
        started = time.monotonic()
        data = self._post(
            f"{self._base}/v1/messages",
            {"x-api-key": self._key or "", "anthropic-version": "2023-06-01", "content-type": "application/json"},
            {
                "model": self.model,
                "max_tokens": request.max_output_tokens,
                "temperature": request.temperature,
                "system": request.system,
                "messages": [{"role": m.role, "content": m.content} for m in request.messages],
            },
        )
        try:
            text = "".join(block["text"] for block in data["content"] if block.get("type") == "text")
            usage = data.get("usage") or {}
        except (KeyError, TypeError) as e:
            raise ProviderInvalidResponse("unexpected response shape from Anthropic") from e
        return LLMResponse(
            text,
            self.name,
            data.get("model", self.model),
            usage.get("input_tokens"),
            usage.get("output_tokens"),
            int((time.monotonic() - started) * 1000),
        )


class OpenAICompatibleProvider(_HttpProvider):
    """Works with OpenAI and any server implementing /chat/completions (vLLM, Ollama, LiteLLM, Azure gateways...)."""

    name = "openai_compatible"

    def __init__(self, model: str, api_key: str | None, base_url: str | None, timeout: float, client: httpx.Client | None = None):
        if not base_url:
            raise ProviderNotConfigured("AI_API_BASE_URL is required for the openai_compatible provider")
        super().__init__(model, api_key, base_url, timeout, client)

    def complete(self, request: LLMRequest) -> LLMResponse:
        started = time.monotonic()
        data = self._post(
            f"{self._base}/chat/completions",
            {"authorization": f"Bearer {self._key}", "content-type": "application/json"},
            {
                "model": self.model,
                "max_tokens": request.max_output_tokens,
                "temperature": request.temperature,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": request.system},
                    *({"role": m.role, "content": m.content} for m in request.messages),
                ],
            },
        )
        try:
            text = data["choices"][0]["message"]["content"]
            usage = data.get("usage") or {}
        except (KeyError, IndexError, TypeError) as e:
            raise ProviderInvalidResponse("unexpected response shape from provider") from e
        return LLMResponse(
            text or "",
            self.name,
            data.get("model", self.model),
            usage.get("prompt_tokens"),
            usage.get("completion_tokens"),
            int((time.monotonic() - started) * 1000),
        )


class UnavailableProvider(LLMProvider):
    """Stands in for a real provider that cannot be constructed (missing key/URL). It never invents an answer."""

    def __init__(self, name: str, model: str, reason: str):
        self.name, self.model, self._reason = name, model, reason

    def configured(self) -> bool:
        return False

    def complete(self, request: LLMRequest) -> LLMResponse:
        raise ProviderNotConfigured(self._reason)
