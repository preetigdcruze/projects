#!/usr/bin/env python3
"""Guided demo of three complete workflows against a running PaySense stack (standard library only).

    python3 scripts/demo.py [--base-url http://localhost:8080] [--admin-password ...]

Workflow 1  Happy path with API idempotency: create (duplicate request replayed), authorize, capture, ledger, refund.
Workflow 2  Ambiguous processor timeout: UNCERTAIN -> asynchronous reconciliation -> AI investigation with cited evidence.
Workflow 3  Reconciliation with injected defects -> discrepancy -> acknowledgement -> incident -> AI summary and analytics Q&A.

It only uses public API endpoints and development accounts, and works with the mock AI provider (no API key needed).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
import uuid


class Api:
    def __init__(self, base: str):
        self.base, self.token = base.rstrip("/"), None

    def call(self, method: str, path: str, body=None, headers=None, expect=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(f"{self.base}{path}", data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                status, raw, hdrs = r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            status, raw, hdrs = e.code, e.read(), dict(e.headers)
        payload = json.loads(raw) if raw else None
        if expect and status not in expect:
            sys.exit(f"Unexpected HTTP {status} for {method} {path}: {payload}")
        return status, payload, hdrs


def step(title: str) -> None:
    print(f"\n\033[1m== {title}\033[0m")


def show(label: str, value) -> None:
    print(f"   {label:<28} {value}")


def wait_for(fn, what: str, timeout: float = 30.0, interval: float = 0.5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = fn()
        if result:
            return result
        time.sleep(interval)
    sys.exit(f"Timed out waiting for {what}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://localhost:8080")
    ap.add_argument("--admin-password", default="admin-demo-pass")
    args = ap.parse_args()
    api = Api(args.base_url)

    step("Signing in as the development admin")
    _, login, _ = api.call("POST", "/api/v1/auth/login", {"username": "admin", "password": args.admin_password}, expect={200})
    api.token = login["accessToken"]
    show("role", login["role"])

    # ------------------------------------------------------------------------------------------------------------
    step("WORKFLOW 1 - payment lifecycle with API idempotency")
    key = f"demo-{uuid.uuid4()}"
    body = {"amount": 49.99, "currency": "EUR", "merchantId": "merchant-demo", "processor": "MOCK_PROCESSOR", "description": "Demo purchase"}
    s1, p1, _ = api.call("POST", "/api/v1/payments", body, {"Idempotency-Key": key}, expect={201})
    s2, p2, h2 = api.call("POST", "/api/v1/payments", body, {"Idempotency-Key": key}, expect={201})
    show("first request", f"{s1} created {p1['id']}")
    show("duplicate request", f"{s2} replayed={h2.get('Idempotent-Replayed')} same payment={p1['id'] == p2['id']}")
    s3, err, _ = api.call("POST", "/api/v1/payments", {**body, "amount": 50.00}, {"Idempotency-Key": key})
    show("same key, other payload", f"{s3} {err['code']}")
    pid = p1["id"]
    _, a, _ = api.call("POST", f"/api/v1/payments/{pid}/authorize", expect={200})
    _, c, _ = api.call("POST", f"/api/v1/payments/{pid}/capture", expect={200})
    show("authorize -> capture", f"{a['status']} -> {c['status']}")
    _, ledger, _ = api.call("GET", f"/api/v1/payments/{pid}/ledger")
    for tx in ledger:
        show(f"ledger {tx['operation']}", ", ".join(f"{e['direction']} {e['account']} {e['amount']}" for e in tx["entries"]))
    _, r, _ = api.call("POST", f"/api/v1/payments/{pid}/refund", {}, expect={200})
    show("refund (full)", f"{r['status']}; original amount unchanged: {r['amount']}")
    s4, e4, _ = api.call("POST", f"/api/v1/payments/{pid}/capture")
    show("capture after refund", f"{s4} {e4['code']} (state machine)")
    _, events, _ = api.call("GET", f"/api/v1/payments/{pid}/events")
    show("audit trail", " > ".join(ev["eventType"] for ev in events["items"]))

    # ------------------------------------------------------------------------------------------------------------
    step("WORKFLOW 2 - ambiguous processor timeout, reconciliation and AI investigation")
    body2 = {**body, "amount": 89.90, "description": "Demo: processor timeout [sim:timeout]"}
    _, p, _ = api.call("POST", "/api/v1/payments", body2, expect={201})
    pid = p["id"]
    s, u, _ = api.call("POST", f"/api/v1/payments/{pid}/authorize")
    show("authorize", f"HTTP {s}: {u['status']} (pending {u.get('pendingOperation')}) - the processor executed it but the answer was lost")
    s, blocked, _ = api.call("POST", f"/api/v1/payments/{pid}/authorize")
    show("retry while uncertain", f"{s} {blocked['code']} (no blind retry, no double charge)")
    done = wait_for(lambda: (lambda x: x if x["status"] != "UNCERTAIN" else None)(api.call("GET", f"/api/v1/payments/{pid}")[1]), "asynchronous resolution")
    show("after reconciliation", f"{done['status']} (resolved by a read-only processor lookup via the ProcessorTimeout event)")
    _, events, _ = api.call("GET", f"/api/v1/payments/{pid}/events")
    show("audit trail", " > ".join(ev["eventType"] for ev in events["items"]))
    _, inv, _ = api.call("POST", "/api/v1/ai/investigations", {"subjectType": "PAYMENT", "subjectId": pid, "question": "Why did this payment time out and is it safe?"})
    show("AI investigation", f"{inv['status']} via {inv.get('provider')} ({inv.get('promptTokens')}+{inv.get('completionTokens')} tokens)")
    result = inv.get("result")
    if inv["status"] == "UNAVAILABLE" or not result:
        show("note", "AI service unavailable: payments are unaffected, no answer was invented")
    else:
        a = result.get("analysis")
        show("verified facts", f"{len(result['facts'])} retrieved records, e.g. {result['facts'][0]['id']}")
        if a:
            show("most likely (AI)", a["most_likely_explanation"]["statement"])
            show("confidence", f"{a['confidence']} - {a['confidence_explanation']}")
            show("cites", ", ".join(a["most_likely_explanation"]["evidence_ids"][:4]))
        else:
            show("note", result.get("notice"))

    # ------------------------------------------------------------------------------------------------------------
    step("WORKFLOW 3 - reconciliation with injected defects, incident and AI summary")
    for i in range(6):  # make sure there is recent captured activity to reconcile
        _, q, _ = api.call("POST", "/api/v1/payments", {**body, "amount": 10 + i, "description": f"Recon demo {i}"}, expect={201})
        api.call("POST", f"/api/v1/payments/{q['id']}/authorize", expect={200})
        api.call("POST", f"/api/v1/payments/{q['id']}/capture", expect={200})
    s, run, _ = api.call("POST", "/api/v1/reconciliations", {"processor": "MOCK_PROCESSOR", "scenario": "WITH_DISCREPANCIES"})
    if s != 201:
        sys.exit(f"Reconciliation failed: {run}")
    show("run", f"{run['status']}: {run['matchedCount']} matched, {run['discrepancyCount']} discrepancies of {run['reportCount']} report lines")
    _, discs, _ = api.call("GET", f"/api/v1/reconciliations/{run['id']}/discrepancies")
    for d in discs["items"]:
        show(d["type"], f"{d['operation']} payment {d['paymentReference'][:8]}  internal={d.get('internalAmount')} report={d.get('reportAmount')}")
    target = next((d for d in discs["items"] if d["type"] == "AMOUNT_MISMATCH"), discs["items"][0])
    _, ack, _ = api.call("POST", f"/api/v1/reconciliations/discrepancies/{target['id']}/acknowledge", {"explanation": "Demo: processor rounding defect confirmed with their support (ticket DEMO-1)."}, expect={200})
    show("acknowledged", f"{ack['status']} by {ack['acknowledgedBy']}; ledger and payments untouched")
    api.call("POST", "/api/v1/ai/anomalies/detect", {"bucket": "HOUR", "evaluate_last": 6})  # best effort; no-op if the AI service is down
    time.sleep(1.5)  # let the discrepancy events reach the incident consumer
    _, incs, _ = api.call("GET", "/api/v1/incidents?status=OPEN")
    show("open incidents", "; ".join(f"{i['title']} [{i['severity']}]" for i in incs["items"][:4]) or "none")
    if incs["items"]:
        inc = incs["items"][0]
        _, rep, _ = api.call("POST", f"/api/v1/incidents/{inc['id']}/summarize")
        if rep.get("status") == "UNAVAILABLE":
            show("AI summary", "AI service unavailable (core features unaffected)")
        else:
            show("AI summary", f"{rep['status']}: affected={rep['affectedComponents']} counts={rep['failureCounts']}")
            show("computed impact", f"{rep['impact']['paymentsAffected']} payments (figures computed from records, not by the model)")
    _, ans, _ = api.call("POST", "/api/v1/ai/analytics-queries", {"question": "Which processor has the highest failure rate today?"})
    show("analytics Q&A", (ans.get("explanation") or ans.get("message") or ans.get("notice") or "")[:150])
    print("\nDone. Open the UI (http://localhost:3000, or :5173 in dev) to explore the same data.")


if __name__ == "__main__":
    main()
