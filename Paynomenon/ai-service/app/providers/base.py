from __future__ import annotations

import logging
import time
from abc import ABC, abstractmethod
from collections import Counter, deque
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from threading import Lock

from ..redaction import redact

log = logging.getLogger("paysense.ai.provider")


class TaskType(StrEnum):
    INVESTIGATION = "investigation"
    ANALYTICS_PLAN = "analytics_plan"
    ANALYTICS_EXPLAIN = "analytics_explain"
    INCIDENT_SUMMARY = "incident_summary"
    RUNBOOK_ANSWER = "runbook_answer"


@dataclass(frozen=True)
class LLMMessage:
    role: str  # "user" | "assistant"
    content: str


@dataclass(frozen=True)
class LLMRequest:
    task: TaskType
    system: str
    messages: list[LLMMessage]
    max_output_tokens: int = 1200
    temperature: float = 0.0


@dataclass(frozen=True)
class LLMResponse:
    text: str
    provider: str
    model: str
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    latency_ms: int = 0


class ProviderError(Exception):
    """Base class. `category` is a stable, low-cardinality label used in metrics and API responses."""

    category = "PROVIDER_ERROR"
    retryable = False

    def __init__(self, message: str = "", retry_after: float | None = None):
        super().__init__(message or self.category)
        self.retry_after = retry_after


class ProviderTimeout(ProviderError):
    category, retryable = "PROVIDER_TIMEOUT", True


class ProviderRateLimited(ProviderError):
    category, retryable = "PROVIDER_RATE_LIMITED", True


class ProviderUnavailable(ProviderError):
    category, retryable = "PROVIDER_UNAVAILABLE", True


class ProviderAuthError(ProviderError):
    category = "PROVIDER_AUTH_ERROR"


class ProviderBadRequest(ProviderError):
    category = "PROVIDER_BAD_REQUEST"


class ProviderNotConfigured(ProviderError):
    category = "PROVIDER_NOT_CONFIGURED"


class ProviderInvalidResponse(ProviderError):
    category = "PROVIDER_INVALID_RESPONSE"


class LLMProvider(ABC):
    """Everything provider-specific lives behind this interface. Callers never see HTTP, SDKs or vendor payloads."""

    name: str
    model: str

    @abstractmethod
    def complete(self, request: LLMRequest) -> LLMResponse: ...

    def configured(self) -> bool:
        return True


@dataclass
class ProviderStats:
    """In-memory operational view for /provider-status. Holds counts and categories only - never prompts or keys."""

    requests: int = 0
    successes: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    errors: Counter = field(default_factory=Counter)
    recent: deque = field(default_factory=lambda: deque(maxlen=50))
    last_success_at: float | None = None
    last_error_at: float | None = None
    _lock: Lock = field(default_factory=Lock)

    def ok(self, r: LLMResponse) -> None:
        with self._lock:
            self.requests += 1
            self.successes += 1
            self.prompt_tokens += r.prompt_tokens or 0
            self.completion_tokens += r.completion_tokens or 0
            self.last_success_at = time.time()
            self.recent.append(("ok", time.time()))

    def failed(self, category: str) -> None:
        with self._lock:
            self.requests += 1
            self.errors[category] += 1
            self.last_error_at = time.time()
            self.recent.append((category, time.time()))

    def snapshot(self) -> dict:
        with self._lock:
            recent_errors = Counter(c for c, _ in self.recent if c != "ok")
            return {
                "requests": self.requests,
                "successes": self.successes,
                "errorCounts": dict(self.errors),
                "recentErrorCategories": dict(recent_errors),
                "promptTokens": self.prompt_tokens,
                "completionTokens": self.completion_tokens,
                "lastSuccessAt": self.last_success_at,
                "lastErrorAt": self.last_error_at,
            }


class RedactingProvider(LLMProvider):
    """Last line of defence: no prompt leaves the process without redaction of secrets, cards and personal data."""

    def __init__(self, inner: LLMProvider):
        self.inner, self.name, self.model = inner, inner.name, inner.model
        self.redactions = 0

    def configured(self) -> bool:
        return self.inner.configured()

    def complete(self, request: LLMRequest) -> LLMResponse:
        system = redact(request.system)
        msgs = [LLMMessage(m.role, redact(m.content)) for m in request.messages]
        if system != request.system or any(a.content != b.content for a, b in zip(msgs, request.messages, strict=True)):
            self.redactions += 1
        return self.inner.complete(LLMRequest(request.task, system, msgs, request.max_output_tokens, request.temperature))


class ResilientProvider(LLMProvider):
    """Bounded retries with jittered exponential backoff for retryable errors (all our requests are read-only, hence safe)."""

    MAX_RETRY_AFTER = 10.0

    def __init__(
        self,
        inner: LLMProvider,
        stats: ProviderStats,
        max_retries: int = 2,
        backoff: float = 0.5,
        sleep: Callable[[float], None] = time.sleep,
        random: Callable[[], float] | None = None,
    ):
        import random as _random

        self.inner, self.stats, self.max_retries, self.backoff, self._sleep = inner, stats, max_retries, backoff, sleep
        self._random = random or _random.random
        self.name, self.model = inner.name, inner.model

    def configured(self) -> bool:
        return self.inner.configured()

    def complete(self, request: LLMRequest) -> LLMResponse:
        attempt = 0
        while True:
            try:
                response = self.inner.complete(request)
                self.stats.ok(response)
                return response
            except ProviderError as e:
                if not e.retryable or attempt >= self.max_retries:
                    self.stats.failed(e.category)
                    raise
                delay = (
                    min(e.retry_after, self.MAX_RETRY_AFTER) if e.retry_after else self.backoff * (2**attempt) * (0.5 + self._random() / 2)
                )
                log.warning("provider %s failed with %s, retry %d in %.2fs", self.name, e.category, attempt + 1, delay)
                self._sleep(delay)
                attempt += 1
