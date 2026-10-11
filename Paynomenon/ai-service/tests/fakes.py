"""In-memory stand-in for the PaySense backend's read API, used by tests and the evaluation harness."""

from __future__ import annotations

import re
from typing import Any

from app.backend_client import BackendError, ForbiddenToolCall, assert_allowed

PID = "11111111-1111-1111-1111-111111111111"
INC = "22222222-2222-2222-2222-222222222222"
ANOM = "33333333-3333-3333-3333-333333333333"
T0 = "2026-10-15T09:00:00Z"


class FakeBackend:
    """Implements BackendReader. `deny` makes path prefixes answer 403 (a role without access); `down` simulates an outage."""

    def __init__(self, data: dict[str, Any] | None = None, deny: tuple[str, ...] = (), down: bool = False):
        self.data = data or {}
        self.deny, self.down = deny, down
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        assert_allowed(path)  # the fake enforces the same allow-list as the real client
        self.calls.append((path, {k: v for k, v in (params or {}).items() if v is not None}))
        if self.down:
            raise BackendError("unavailable", "backend down")
        if any(path.startswith(d) for d in self.deny):
            raise BackendError("denied", "denied", 403)
        for pattern, value in self.data.items():
            if re.fullmatch(pattern, path):
                if value is None:
                    raise BackendError("not_found", "nf", 404)
                return value(params) if callable(value) else value
        raise BackendError("not_found", f"no fixture for {path}", 404)


def attempt(
    n: int, op: str, status: str, code: str | None, cat: str | None, ms: int | None, message: str | None = None, pid: str = PID
) -> dict:
    return {
        "id": f"aaaaaaaa-0000-0000-0000-{n:012d}",
        "operation": op,
        "attemptNumber": n,
        "processor": "MOCK_PROCESSOR",
        "processorRequestId": f"{pid}:{op}:{n}",
        "status": status,
        "responseCode": code,
        "failureCategory": cat,
        "responseTimeMs": ms,
        "sanitizedResponse": {"message": message} if message else {},
        "correlationId": "corr-1",
        "startedAt": T0,
        "completedAt": T0,
    }


def event(n: int, etype: str, frm: str | None, to: str | None, meta: dict | None = None) -> dict:
    return {
        "id": f"eeeeeeee-0000-0000-0000-{n:012d}",
        "sequence": n,
        "eventType": etype,
        "fromStatus": frm,
        "toStatus": to,
        "source": "API",
        "actor": "it",
        "correlationId": "corr-1",
        "metadata": meta or {},
        "occurredAt": f"2026-10-15T09:00:{n:02d}Z",
    }


def payment(status: str, attempts: list[dict], description: str | None = "Demo purchase", failure_code: str | None = None) -> dict:
    return {
        "id": PID,
        "merchantId": "merchant-demo",
        "amount": 49.99,
        "currency": "EUR",
        "processor": "MOCK_PROCESSOR",
        "description": description,
        "status": status,
        "pendingOperation": None,
        "failureCode": failure_code,
        "failureCategory": None,
        "correlationId": "corr-1",
        "synthetic": True,
        "createdAt": T0,
        "updatedAt": T0,
        "attempts": attempts,
    }


def log(n: int, message: str, level: str = "ERROR", component: str = "processor-client") -> dict:
    return {
        "id": n,
        "occurredAt": T0,
        "level": level,
        "component": component,
        "message": message,
        "correlationId": "corr-1",
        "paymentId": PID,
        "attributes": {},
    }


def stats(p95: int = 120, failure: float = 0.05, timeouts: float = 0.01) -> list[dict]:
    return [
        {
            "processor": "MOCK_PROCESSOR",
            "attempts": 120,
            "approved": 114,
            "declined": 4,
            "invalid": 0,
            "unavailable": 1,
            "timeouts": 1,
            "failureRate": failure,
            "timeoutRate": timeouts,
            "latency": {"p50": 90, "p95": p95, "p99": p95 + 50, "sampleSize": 119, "sufficientSample": True, "minSample": 20},
        }
    ]


def page(items: list[dict]) -> dict:
    return {"items": items, "page": 0, "size": 50, "totalItems": len(items), "totalPages": 1}


RUNBOOK_HITS = [
    {
        "docKey": "rb-processor-timeouts",
        "version": 1,
        "docType": "RUNBOOK",
        "title": "Runbook - Processor timeouts and UNCERTAIN payments",
        "tags": ["timeout"],
        "snippet": "A timeout does not prove the processor failed. «Resolve» by lookup of the original request id.",
        "rank": 0.5,
    }
]


def backend_for(
    pay: dict,
    events: list[dict],
    logs: list[dict],
    discrepancies: list[dict] | None = None,
    statistics: list[dict] | None = None,
    anomalies: list[dict] | None = None,
    **kw,
) -> FakeBackend:
    return FakeBackend(
        {
            rf"/api/v1/payments/{PID}": pay,
            rf"/api/v1/payments/{PID}/events": page(events),
            r"/api/v1/operational-logs": page(logs),
            r"/api/v1/reconciliations/discrepancies": page(discrepancies or []),
            r"/api/v1/analytics/processors": statistics if statistics is not None else stats(),
            r"/api/v1/anomalies": page(anomalies or []),
            r"/api/v1/runbooks/search": RUNBOOK_HITS,
        },
        **kw,
    )


def timeout_case(**kw) -> FakeBackend:
    att = [attempt(1, "AUTHORIZE", "TIMEOUT", "TIMEOUT", "TIMEOUT", 5000, None)]
    evs = [
        event(1, "PAYMENT_CREATED", None, "CREATED"),
        event(2, "OPERATION_STARTED", "CREATED", "PROCESSING"),
        event(3, "OUTCOME_UNCERTAIN", "PROCESSING", "UNCERTAIN", {"operation": "AUTHORIZE", "reason": "processor timeout after 5000ms"}),
        event(4, "OUTCOME_RESOLVED", "UNCERTAIN", "AUTHORIZED", {"operation": "AUTHORIZE", "resolvedBy": "processor-lookup"}),
    ]
    return backend_for(
        payment("AUTHORIZED", att),
        evs,
        [log(101, "Timeout calling MOCK_PROCESSOR for AUTHORIZE: outcome unknown")],
        statistics=stats(p95=4200, timeouts=0.08),
        **kw,
    )


def insufficient_funds_case(**kw) -> FakeBackend:
    att = [attempt(1, "AUTHORIZE", "DECLINED", "INSUFFICIENT_FUNDS", "DECLINED", 95, "Declined: insufficient funds (synthetic)")]
    evs = [
        event(1, "PAYMENT_CREATED", None, "CREATED"),
        event(2, "OPERATION_DECLINED", "PROCESSING", "FAILED", {"operation": "AUTHORIZE", "responseCode": "INSUFFICIENT_FUNDS"}),
    ]
    return backend_for(payment("FAILED", att, failure_code="INSUFFICIENT_FUNDS"), evs, [], **kw)


def unavailable_case(**kw) -> FakeBackend:
    att = [attempt(1, "AUTHORIZE", "UNAVAILABLE", "PROCESSOR_UNAVAILABLE", "UNAVAILABLE", 310)]
    evs = [
        event(1, "PAYMENT_CREATED", None, "CREATED"),
        event(2, "OPERATION_NOT_EXECUTED", "PROCESSING", "CREATED", {"operation": "AUTHORIZE"}),
    ]
    return backend_for(
        payment("CREATED", att),
        evs,
        [log(201, "MOCK_PROCESSOR unavailable for AUTHORIZE: MOCK_PROCESSOR stayed unavailable after 3 attempts")],
        statistics=stats(failure=0.4),
        **kw,
    )


def discrepancy_case(**kw) -> FakeBackend:
    att = [attempt(1, "AUTHORIZE", "APPROVED", "APPROVED", None, 90), attempt(2, "CAPTURE", "APPROVED", "APPROVED", None, 85)]
    evs = [event(1, "PAYMENT_CREATED", None, "CREATED"), event(2, "OPERATION_SUCCEEDED", "CAPTURING", "CAPTURED")]
    d = {
        "id": "dddddddd-0000-0000-0000-000000000001",
        "runId": INC,
        "type": "AMOUNT_MISMATCH",
        "paymentReference": PID,
        "operation": "CAPTURE",
        "internalAmount": 49.99,
        "internalCurrency": "EUR",
        "reportAmount": 50.99,
        "reportCurrency": "EUR",
        "status": "OPEN",
        "createdAt": T0,
        "details": {},
    }
    return backend_for(payment("CAPTURED", att), evs, [], discrepancies=[d], **kw)


def thin_case(**kw) -> FakeBackend:
    return backend_for(payment("CREATED", []), [], [], statistics=[], **kw)


def incident_backend(**kw) -> FakeBackend:
    anomalies = [
        {
            "id": ANOM,
            "metric": "FAILURE_RATE",
            "dimension": "MOCK_PROCESSOR",
            "severity": "HIGH",
            "observed": 0.6,
            "baseline": 0.05,
            "windowStart": T0,
            "windowEnd": "2026-10-15T10:00:00Z",
            "detectedAt": T0,
        }
    ]
    payments = [
        {
            "id": f"{i:08d}-0000-0000-0000-000000000000",
            "status": "FAILED",
            "amount": 10.5 + i,
            "currency": "EUR",
            "processor": "MOCK_PROCESSOR",
            "failureCode": "INSUFFICIENT_FUNDS",
            "createdAt": T0,
        }
        for i in range(1, 5)
    ]
    detail = {
        "incident": {
            "id": INC,
            "title": "failure rate anomaly on MOCK_PROCESSOR",
            "status": "OPEN",
            "severity": "HIGH",
            "source": "ANOMALY",
            "components": ["MOCK_PROCESSOR"],
            "description": "auto",
            "startedAt": T0,
            "resolvedAt": None,
            "counts": {},
        },
        "payments": payments,
        "anomalies": anomalies,
        "discrepancies": [],
        "deadLetterIds": [],
        "timeline": [
            {"at": T0, "kind": "INCIDENT", "refId": INC, "title": "Incident opened", "detail": None, "paymentId": None},
            {
                "at": T0,
                "kind": "LOG",
                "refId": "301",
                "title": "processor-client",
                "detail": "Retrying AUTHORIZE after attempt 1 failed",
                "paymentId": payments[0]["id"],
            },
        ],
    }
    return FakeBackend(
        {
            rf"/api/v1/incidents/{INC}": detail,
            r"/api/v1/analytics/processors": stats(failure=0.6),
            r"/api/v1/runbooks/search": RUNBOOK_HITS,
        },
        **kw,
    )


_ = ForbiddenToolCall
