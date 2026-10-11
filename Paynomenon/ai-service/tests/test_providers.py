import json

import httpx
import pytest

from app.config import Settings
from app.providers import (
    LLMMessage,
    LLMRequest,
    ProviderAuthError,
    ProviderBadRequest,
    ProviderInvalidResponse,
    ProviderNotConfigured,
    ProviderRateLimited,
    ProviderStats,
    ProviderTimeout,
    ProviderUnavailable,
    TaskType,
    build_provider,
)
from app.providers.base import RedactingProvider, ResilientProvider
from app.providers.http_providers import AnthropicProvider, OpenAICompatibleProvider
from app.providers.mock import MockProvider

REQ = LLMRequest(TaskType.INVESTIGATION, "system", [LLMMessage("user", "hello")], 100)


def client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def anthropic_ok(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200, json={"model": "claude-x", "content": [{"type": "text", "text": '{"a":1}'}], "usage": {"input_tokens": 11, "output_tokens": 7}}
    )


def test_anthropic_request_shape_and_usage_tracking():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["headers"], seen["body"] = request.headers, json.loads(request.content)
        return anthropic_ok(request)

    p = AnthropicProvider("claude-x", "k-123", None, 5, client(handler))
    r = p.complete(REQ)
    assert (r.text, r.prompt_tokens, r.completion_tokens, r.provider, r.model) == ('{"a":1}', 11, 7, "anthropic", "claude-x")
    assert seen["headers"]["x-api-key"] == "k-123" and seen["headers"]["anthropic-version"]
    assert seen["body"]["system"] == "system" and seen["body"]["max_tokens"] == 100 and seen["body"]["temperature"] == 0


def test_openai_compatible_request_shape():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"], seen["body"], seen["auth"] = str(request.url), json.loads(request.content), request.headers["authorization"]
        return httpx.Response(
            200, json={"choices": [{"message": {"content": "{}"}}], "usage": {"prompt_tokens": 5, "completion_tokens": 2}}
        )

    p = OpenAICompatibleProvider("gpt-x", "sk-abc", "https://llm.example/v1/", 5, client(handler))
    r = p.complete(REQ)
    assert seen["url"] == "https://llm.example/v1/chat/completions" and seen["auth"] == "Bearer sk-abc"
    assert seen["body"]["messages"][0] == {"role": "system", "content": "system"} and (r.prompt_tokens, r.completion_tokens) == (5, 2)


@pytest.mark.parametrize(
    ("status", "exc"),
    [
        (429, ProviderRateLimited),
        (500, ProviderUnavailable),
        (529, ProviderUnavailable),
        (504, ProviderTimeout),
        (401, ProviderAuthError),
        (403, ProviderAuthError),
        (400, ProviderBadRequest),
    ],
)
def test_http_errors_are_classified(status, exc):
    p = AnthropicProvider("m", "k", None, 5, client(lambda r: httpx.Response(status, json={"error": "x"}, headers={"retry-after": "3"})))
    with pytest.raises(exc) as e:
        p.complete(REQ)
    if status == 429:
        assert e.value.retry_after == 3.0
    assert e.value.retryable == (status in (429, 500, 529, 504))


def test_network_timeout_and_garbage_responses():
    def boom(request):
        raise httpx.ReadTimeout("slow")

    with pytest.raises(ProviderTimeout):
        AnthropicProvider("m", "k", None, 5, client(boom)).complete(REQ)
    with pytest.raises(ProviderUnavailable):
        AnthropicProvider("m", "k", None, 5, client(lambda r: (_ for _ in ()).throw(httpx.ConnectError("no route")))).complete(REQ)
    with pytest.raises(ProviderInvalidResponse):
        AnthropicProvider("m", "k", None, 5, client(lambda r: httpx.Response(200, text="<html>"))).complete(REQ)
    with pytest.raises(ProviderInvalidResponse):
        AnthropicProvider("m", "k", None, 5, client(lambda r: httpx.Response(200, json={"unexpected": True}))).complete(REQ)


def test_missing_key_is_not_configured_and_never_falls_back_to_the_mock():
    s = Settings(provider="anthropic", api_key=None)  # type: ignore[arg-type]
    p = build_provider(s, ProviderStats())
    assert not p.configured()
    with pytest.raises(ProviderNotConfigured):
        p.complete(REQ)
    s2 = Settings(provider="openai_compatible", api_key="k", api_base_url=None)  # type: ignore[arg-type]
    with pytest.raises(ProviderNotConfigured):
        build_provider(s2, ProviderStats()).complete(REQ)


def test_mock_is_only_used_when_explicitly_selected():
    assert isinstance(build_provider(Settings(provider="mock"), ProviderStats()).inner.inner, MockProvider)  # type: ignore[attr-defined]
    assert Settings().provider == "mock"  # the default keeps the app runnable without a paid account


def test_api_key_is_never_exposed_by_settings_repr():
    s = Settings(provider="anthropic", api_key="sk-super-secret-value-123")  # type: ignore[arg-type]
    assert "sk-super-secret-value-123" not in repr(s) and "sk-super-secret-value-123" not in str(s.model_dump())


class Flaky:
    name, model = "flaky", "m"

    def __init__(self, failures):
        self.failures, self.calls = list(failures), 0

    def configured(self):
        return True

    def complete(self, request):
        self.calls += 1
        if self.failures:
            raise self.failures.pop(0)
        from app.providers import LLMResponse

        return LLMResponse("{}", "flaky", "m", 1, 1)


def test_bounded_retries_for_retryable_errors_with_backoff_and_retry_after():
    sleeps = []
    inner = Flaky([ProviderUnavailable(), ProviderRateLimited(retry_after=2.0)])
    stats = ProviderStats()
    p = ResilientProvider(inner, stats, max_retries=2, backoff=0.5, sleep=sleeps.append, random=lambda: 0.0)
    assert p.complete(REQ).text == "{}"
    assert inner.calls == 3 and sleeps == [0.25, 2.0]  # first: backoff*0.5 jitter floor, second: provider's Retry-After
    assert stats.snapshot()["successes"] == 1


def test_retry_budget_is_exhausted_and_errors_are_counted():
    inner = Flaky([ProviderTimeout()] * 5)
    stats = ProviderStats()
    p = ResilientProvider(inner, stats, max_retries=2, backoff=0.0, sleep=lambda s: None)
    with pytest.raises(ProviderTimeout):
        p.complete(REQ)
    assert inner.calls == 3
    assert stats.snapshot()["errorCounts"] == {"PROVIDER_TIMEOUT": 1}


def test_non_retryable_errors_are_not_retried_and_huge_retry_after_is_capped():
    inner = Flaky([ProviderAuthError()])
    with pytest.raises(ProviderAuthError):
        ResilientProvider(inner, ProviderStats(), 3, 0.0, sleep=lambda s: None).complete(REQ)
    assert inner.calls == 1
    sleeps = []
    ResilientProvider(Flaky([ProviderRateLimited(retry_after=9999)]), ProviderStats(), 1, 0.0, sleep=sleeps.append).complete(REQ)
    assert sleeps == [ResilientProvider.MAX_RETRY_AFTER]


def test_secrets_are_redacted_before_a_request_leaves_the_process():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["raw"] = request.content.decode()
        return anthropic_ok(request)

    s = Settings(provider="anthropic", api_key="k", provider_max_retries=0)  # type: ignore[arg-type]
    p = build_provider(s, ProviderStats(), client(handler))
    p.complete(
        LLMRequest(
            TaskType.INVESTIGATION,
            "sys",
            [LLMMessage("user", "log: card 4111 1111 1111 1111 mail ops@example.com password=swordfish123 Bearer abcdefghijklmnop1234")],
            50,
        )
    )
    raw = seen["raw"]
    for leaked in ("4111 1111 1111 1111", "ops@example.com", "swordfish123", "abcdefghijklmnop1234"):
        assert leaked not in raw
    assert "[REDACTED:card_number]" in raw and isinstance(p, RedactingProvider) and p.redactions == 1
