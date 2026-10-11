"""Read-only access to the PaySense backend.

The AI layer's "tools" all go through this module, which enforces three things structurally rather than by convention:
  1. only HTTP GET exists - there is no method for POST/PUT/DELETE on the user-scoped client;
  2. only allow-listed path shapes can be requested (no refunds, no admin, no arbitrary URLs);
  3. every request carries the *caller's* bearer token, so the backend's own authorization decides what is visible.
"""

from __future__ import annotations

import re
from typing import Any, Protocol

import httpx

_UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
ALLOWED_GET_PATHS = [
    re.compile(rf"^/api/v1/payments/{_UUID}$"),
    re.compile(rf"^/api/v1/payments/{_UUID}/events$"),
    re.compile(r"^/api/v1/operational-logs$"),
    re.compile(r"^/api/v1/reconciliations/discrepancies$"),
    re.compile(rf"^/api/v1/incidents/{_UUID}$"),
    re.compile(r"^/api/v1/anomalies$"),
    re.compile(rf"^/api/v1/anomalies/{_UUID}$"),
    re.compile(r"^/api/v1/analytics/(overview|payment-trends|failure-reasons|processors|timeseries)$"),
    re.compile(r"^/api/v1/runbooks/search$"),
]


class BackendError(Exception):
    """kind: not_found | denied | unavailable | invalid"""

    def __init__(self, kind: str, message: str, status: int | None = None):
        super().__init__(message)
        self.kind, self.status = kind, status


class ForbiddenToolCall(Exception):
    """Raised when code tries to reach something outside the read-only allow-list. This is a programming error."""


class BackendReader(Protocol):
    def get(self, path: str, params: dict[str, Any] | None = None) -> Any: ...


def assert_allowed(path: str) -> None:
    if ".." in path or "//" in path or not any(p.match(path) for p in ALLOWED_GET_PATHS):
        raise ForbiddenToolCall(f"path not allowed for AI tools: {path!r}")


class BackendClient:
    """GET-only client bound to one caller's Authorization header."""

    def __init__(self, base_url: str, authorization: str | None, http: httpx.Client, correlation_id: str | None = None):
        self._base, self._auth, self._http, self._corr = base_url.rstrip("/"), authorization, http, correlation_id

    def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        assert_allowed(path)
        headers = {"Accept": "application/json"}
        if self._auth:
            headers["Authorization"] = self._auth
        if self._corr:
            headers["X-Correlation-Id"] = self._corr
        clean = {k: v for k, v in (params or {}).items() if v is not None}
        try:
            resp = self._http.get(f"{self._base}{path}", params=clean, headers=headers)
        except httpx.HTTPError as e:
            raise BackendError("unavailable", f"backend unreachable: {type(e).__name__}") from e
        if resp.status_code in (401, 403):
            raise BackendError("denied", "access denied by backend", resp.status_code)
        if resp.status_code == 404:
            raise BackendError("not_found", "not found", 404)
        if resp.status_code == 400:
            raise BackendError("invalid", "backend rejected the query", 400)
        if resp.status_code >= 400:
            raise BackendError("unavailable", f"backend error {resp.status_code}", resp.status_code)
        try:
            return resp.json()
        except ValueError as e:
            raise BackendError("unavailable", "backend returned invalid JSON") from e


class AnomalySink:
    """The single write the AI layer performs: persisting the anomalies the *statistical detector* found.

    It posts to a dedicated internal endpoint with the service credential. It cannot touch payments, ledger or events.
    """

    def __init__(self, base_url: str, service_token: str, http: httpx.Client):
        self._base, self._token, self._http = base_url.rstrip("/"), service_token, http

    def store(self, anomalies: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not anomalies:
            return []
        try:
            resp = self._http.post(
                f"{self._base}/api/v1/internal/anomalies", json={"anomalies": anomalies}, headers={"X-Service-Token": self._token}
            )
        except httpx.HTTPError as e:
            raise BackendError("unavailable", f"backend unreachable: {type(e).__name__}") from e
        if resp.status_code >= 400:
            raise BackendError("unavailable", f"backend rejected anomalies ({resp.status_code})", resp.status_code)
        return resp.json()
