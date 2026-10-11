import httpx
import pytest

from app.backend_client import ALLOWED_GET_PATHS, AnomalySink, BackendClient, BackendError, ForbiddenToolCall, assert_allowed

UUID = "11111111-1111-1111-1111-111111111111"


def make(handler, auth="Bearer user-token"):
    return BackendClient("http://backend.test", auth, httpx.Client(transport=httpx.MockTransport(handler)), "corr-123")


def test_user_scoped_client_has_no_mutating_method():
    assert not any(hasattr(BackendClient, m) for m in ("post", "put", "patch", "delete", "request"))
    assert [m for m in dir(BackendClient) if not m.startswith("_")] == ["get"]


@pytest.mark.parametrize(
    "path",
    [
        f"/api/v1/payments/{UUID}/refund",
        f"/api/v1/payments/{UUID}/capture",
        f"/api/v1/payments/{UUID}/authorize",
        "/api/v1/payments",
        "/api/v1/admin/seed",
        "/api/v1/dev/simulation",
        "/api/v1/internal/anomalies",
        "/api/v1/auth/login",
        "/actuator/prometheus",
        f"/api/v1/payments/{UUID}/../admin",
        "//evil.example.com/x",
        "http://evil.example.com/api/v1/anomalies",
        "/api/v1/events/dead-letters",
        "/api/v1/admin/events/outbox/requeue-failed",
    ],
)
def test_paths_outside_the_read_allow_list_are_refused_before_any_request(path):
    called = []
    c = make(lambda r: called.append(r) or httpx.Response(200, json={}))
    with pytest.raises(ForbiddenToolCall):
        c.get(path)
    assert not called
    with pytest.raises(ForbiddenToolCall):
        assert_allowed(path)


def test_allow_list_covers_exactly_the_documented_read_endpoints():
    for ok in [
        f"/api/v1/payments/{UUID}",
        f"/api/v1/payments/{UUID}/events",
        "/api/v1/operational-logs",
        "/api/v1/analytics/overview",
        "/api/v1/runbooks/search",
    ]:
        assert_allowed(ok)
    assert len(ALLOWED_GET_PATHS) == 9


def test_requests_carry_the_callers_token_and_correlation_id():
    seen = {}

    def handler(r: httpx.Request) -> httpx.Response:
        seen.update(auth=r.headers.get("authorization"), corr=r.headers.get("x-correlation-id"), method=r.method, query=dict(r.url.params))
        return httpx.Response(200, json={"ok": True})

    assert make(handler).get("/api/v1/operational-logs", {"paymentId": UUID, "ignored": None}) == {"ok": True}
    assert seen == {"auth": "Bearer user-token", "corr": "corr-123", "method": "GET", "query": {"paymentId": UUID}}


@pytest.mark.parametrize(
    ("status", "kind"), [(401, "denied"), (403, "denied"), (404, "not_found"), (400, "invalid"), (500, "unavailable"), (503, "unavailable")]
)
def test_backend_errors_are_classified(status, kind):
    with pytest.raises(BackendError) as e:
        make(lambda r: httpx.Response(status, json={})).get(f"/api/v1/payments/{UUID}")
    assert e.value.kind == kind


def test_unreachable_backend_and_invalid_json():
    def boom(r):
        raise httpx.ConnectError("refused")

    with pytest.raises(BackendError) as e:
        make(boom).get(f"/api/v1/payments/{UUID}")
    assert e.value.kind == "unavailable"
    with pytest.raises(BackendError):
        make(lambda r: httpx.Response(200, text="not json")).get(f"/api/v1/payments/{UUID}")


def test_the_only_write_is_anomaly_persistence_with_the_service_credential():
    seen = {}

    def handler(r: httpx.Request) -> httpx.Response:
        seen.update(path=r.url.path, token=r.headers.get("x-service-token"), auth=r.headers.get("authorization"))
        return httpx.Response(200, json=[{"id": "x", "created": True}])

    sink = AnomalySink("http://backend.test", "svc-token", httpx.Client(transport=httpx.MockTransport(handler)))
    assert sink.store([{"metric": "FAILURE_RATE"}]) == [{"id": "x", "created": True}]
    assert seen == {"path": "/api/v1/internal/anomalies", "token": "svc-token", "auth": None}
    assert sink.store([]) == []
