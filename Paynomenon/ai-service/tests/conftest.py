from __future__ import annotations

import pytest

from app.config import Settings
from app.providers.mock import MockProvider


@pytest.fixture
def settings() -> Settings:
    return Settings(provider="mock", internal_token="test-internal-token", backend_url="http://backend.test", provider_backoff_seconds=0.0)  # type: ignore[arg-type]


@pytest.fixture
def mock_provider() -> MockProvider:
    return MockProvider()
