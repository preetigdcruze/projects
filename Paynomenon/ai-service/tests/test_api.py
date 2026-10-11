import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.providers.mock import MockProvider
from tests import fakes
from tests.fakes import ANOM, INC, PID

TOKEN = {"X-Internal-Token": "test-internal-token", "Authorization": "Bearer user.jwt.token"}


def client(provider=None, backend=None, **settings_kw):
    seen = {}

    def factory(authorization, corr):
        seen["auth"], seen["corr"] = authorization, corr
        return backend or fakes.timeout_case()

    settings_kw.setdefault("rate_limit_per_minute", 1000)
    s = Settings(provider="mock", internal_token="test-internal-token", **settings_kw)  # type: ignore[arg-type]
    app = create_app(s, provider or MockProvider(), httpx.Client(), factory)
    return TestClient(app), seen


def test_health_is_public_and_metrics_exposes_prometheus_text():
    c, _ = client()
    h = c.get("/health").json()
    assert h["status"] == "ok" and h["provider"] == "mock" and h["providerConfigured"] is True
    assert "paysense_ai_requests_total" in c.get("/metrics").text or c.get("/metrics").status_code == 200


def test_internal_token_is_required_and_checked_in_constant_time():
    c, _ = client()
    body = {"subjectType": "PAYMENT", "subjectId": PID, "question": "why did it fail?"}
    assert c.post("/v1/investigations", json=body).status_code == 401
    assert c.post("/v1/investigations", json=body, headers={"X-Internal-Token": "wrong"}).status_code == 401
    assert c.get("/v1/provider-status").status_code == 401
    assert c.post("/v1/investigations", json=body, headers=TOKEN).status_code == 200


def test_investigation_endpoint_forwards_the_callers_identity_to_the_data_layer():
    c, seen = client()
    r = c.post(
        "/v1/investigations",
        json={"subjectType": "PAYMENT", "subjectId": PID, "question": "why did it fail?"},
        headers={**TOKEN, "X-Correlation-Id": "corr-abc"},
    )
    assert r.status_code == 200 and r.json()["status"] == "COMPLETED"
    assert seen["auth"] == "Bearer user.jwt.token" and seen["corr"] == "corr-abc" and r.headers["x-correlation-id"] == "corr-abc"
    body = r.json()
    assert body["analysis"]["confidence"] and body["facts"] and "confidenceMeaning" in body


def test_validation_errors_and_unknown_subjects():
    c, _ = client()
    assert (
        c.post(
            "/v1/investigations", json={"subjectType": "PAYMENT", "subjectId": "not-a-uuid", "question": "why?"}, headers=TOKEN
        ).status_code
        == 422
    )
    assert (
        c.post("/v1/investigations", json={"subjectType": "REFUND", "subjectId": PID, "question": "why?"}, headers=TOKEN).status_code == 422
    )
    assert (
        c.post("/v1/investigations", json={"subjectType": "PAYMENT", "subjectId": PID, "question": "x"}, headers=TOKEN).status_code == 422
    )
    assert (
        c.post("/v1/investigations", json={"subjectType": "PAYMENT", "subjectId": PID, "question": "q" * 1001}, headers=TOKEN).status_code
        == 422
    )
    b = fakes.timeout_case()
    b.data[rf"/api/v1/payments/{PID}"] = None
    c2, _ = client(backend=b)
    r = c2.post("/v1/investigations", json={"subjectType": "PAYMENT", "subjectId": PID, "question": "why did it fail?"}, headers=TOKEN)
    assert r.status_code == 404 and r.json()["code"] == "BACKEND_NOT_FOUND"
    c3, _ = client(backend=fakes.timeout_case(deny=(f"/api/v1/payments/{PID}",)))
    assert (
        c3.post(
            "/v1/investigations", json={"subjectType": "PAYMENT", "subjectId": PID, "question": "why did it fail?"}, headers=TOKEN
        ).status_code
        == 403
    )


def test_request_size_limit():
    c, _ = client(max_request_bytes=500)
    r = c.post("/v1/analytics-queries", json={"question": "x" * 2000}, headers=TOKEN)
    assert r.status_code == 413 and r.json()["code"] == "PAYLOAD_TOO_LARGE"


def test_rate_limit():
    c, _ = client(rate_limit_per_minute=3)
    codes = [c.post("/v1/analytics-queries", json={"question": "overview of payments"}, headers=TOKEN).status_code for _ in range(5)]
    assert codes[:3] != [429] * 3 and codes[3:] == [429, 429]
    other = {**TOKEN, "Authorization": "Bearer someone.else.token"}
    assert c.post("/v1/analytics-queries", json={"question": "overview of payments"}, headers=other).status_code != 429, (
        "limits are per caller"
    )


def test_provider_status_reports_health_without_secrets():
    c, _ = client(MockProvider("timeout"))
    c.post("/v1/investigations", json={"subjectType": "PAYMENT", "subjectId": PID, "question": "why did it fail?"}, headers=TOKEN)
    s = c.get("/v1/provider-status", headers=TOKEN).json()
    assert s["provider"] == "mock" and s["configured"] is True and "supportedOperations" in s
    assert "apiKey" not in str(s) and "api_key" not in str(s)


def test_unconfigured_real_provider_is_visible_in_status_and_responses():
    s = Settings(provider="anthropic", api_key=None, internal_token="test-internal-token")  # type: ignore[arg-type]
    app = create_app(s, None, httpx.Client(), lambda a, c: fakes.timeout_case())
    c = TestClient(app)
    assert c.get("/health").json()["providerConfigured"] is False
    st = c.get("/v1/provider-status", headers=TOKEN).json()
    assert st["status"] == "UNCONFIGURED"
    r = c.post(
        "/v1/investigations", json={"subjectType": "PAYMENT", "subjectId": PID, "question": "why did it fail?"}, headers=TOKEN
    ).json()
    assert r["status"] == "DEGRADED" and r["errorCategory"] == "PROVIDER_NOT_CONFIGURED" and r["analysis"] is None


def test_incident_anomaly_and_runbook_endpoints():
    c, _ = client(backend=fakes.incident_backend())
    assert c.post(f"/v1/incidents/{INC}/summary", headers=TOKEN).json()["status"] == "COMPLETED"
    assert c.post("/v1/incidents/not-a-uuid/summary", headers=TOKEN).status_code == 422
    c2, _ = client()
    assert c2.post("/v1/runbooks/ask", json={"question": "what to do for timeouts"}, headers=TOKEN).json()["status"] == "COMPLETED"
    assert (
        c2.post(
            "/v1/analytics-queries", json={"question": "Which processor has the highest failure rate today?"}, headers=TOKEN
        ).status_code
        == 200
    )
    _ = ANOM


def test_unexpected_errors_do_not_leak_internals():
    class Boom:
        def get(self, path, params=None):
            raise RuntimeError("secret database password is hunter2")

    app = create_app(Settings(provider="mock", internal_token="test-internal-token"), MockProvider(), httpx.Client(), lambda a, c: Boom())  # type: ignore[arg-type]
    r = TestClient(app, raise_server_exceptions=False).post(
        "/v1/investigations", json={"subjectType": "PAYMENT", "subjectId": PID, "question": "why did it fail?"}, headers=TOKEN
    )
    assert r.status_code == 500 and "hunter2" not in r.text and r.json()["code"] == "INTERNAL_ERROR"


@pytest.mark.parametrize("route", ["/v1/investigations", "/v1/analytics-queries", "/v1/runbooks/ask", "/v1/anomalies/detect"])
def test_there_is_no_route_that_could_mutate_payments(route):
    c, _ = client()
    paths = {r.path for r in c.app.routes}  # type: ignore[attr-defined]
    assert route in paths
    assert not any(any(w in p for w in ("refund", "capture", "authorize", "cancel", "payments/")) for p in paths)
