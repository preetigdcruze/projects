"""Evidence gathering ("tools"). Each function is read-only, takes validated identifiers and returns Evidence objects.

Evidence ids are minted here (`pay:`, `att:`, `evt:`, `log:`, `disc:`, `anom:`, `stat:`, `inc:`) from the backend's own
identifiers. The model may cite only ids that exist in the evidence set; anything else is rejected as fabricated.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from .backend_client import BackendError, BackendReader
from .models import Evidence
from .untrusted import clean_untrusted

SAFE_EVENT_META = ("operation", "outcome", "responseCode", "attemptNumber", "callbackId", "resolvedBy", "processorRequestId")


@dataclass
class Gathered:
    evidence: list[Evidence] = field(default_factory=list)
    gaps: list[str] = field(default_factory=list)
    injection_flags: list[str] = field(default_factory=list)

    def add(self, e: Evidence) -> None:
        self.evidence.append(e)
        if e.withheld:
            self.injection_flags.append(e.id)


def _ts(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(UTC)
    except ValueError:
        return None


def _untrusted(text: str | None, limit: int) -> tuple[str | None, bool]:
    if not text:
        return None, False
    c = clean_untrusted(text, limit)
    return c.text, c.withheld


def _try(g: Gathered, what: str, fn):
    """Runs a retrieval; converts access/availability problems into explicit gaps instead of failing the investigation."""
    try:
        return fn()
    except BackendError as e:
        if e.kind == "denied":
            g.gaps.append(f"{what}: access denied for your role, so it was not used.")
        elif e.kind == "not_found":
            g.gaps.append(f"{what}: not found.")
        else:
            g.gaps.append(f"{what}: could not be retrieved ({e.kind}).")
        return None


def _payment_ev(p: dict, limit: int) -> Evidence:
    text, withheld = _untrusted(p.get("description"), limit)
    return Evidence(
        id=f"pay:{p['id']}",
        kind="payment",
        summary=f"Payment {p['id']} is {p['status']} ({p['amount']} {p['currency']}, processor {p['processor']}, merchant {p['merchantId']}).",
        data={
            k: p.get(k)
            for k in (
                "status",
                "amount",
                "currency",
                "processor",
                "merchantId",
                "pendingOperation",
                "failureCode",
                "failureCategory",
                "createdAt",
                "updatedAt",
                "correlationId",
            )
        },
        untrusted_text=text,
        withheld=withheld,
        observed_at=_ts(p.get("updatedAt") or p.get("createdAt")),
        link=f"/payments/{p['id']}",
    )


def _attempt_ev(a: dict, payment_id: str, limit: int) -> Evidence:
    msg = (a.get("sanitizedResponse") or {}).get("message")
    text, withheld = _untrusted(msg, limit)
    code = f", code {a['responseCode']}" if a.get("responseCode") else ""
    ms = f", {a['responseTimeMs']} ms" if a.get("responseTimeMs") is not None else ""
    return Evidence(
        id=f"att:{a['id']}",
        kind="attempt",
        summary=f"{a['operation']} attempt #{a['attemptNumber']} on {a['processor']} ended {a['status']}{code}{ms}.",
        data={
            k: a.get(k)
            for k in (
                "operation",
                "attemptNumber",
                "processor",
                "status",
                "responseCode",
                "failureCategory",
                "responseTimeMs",
                "processorRequestId",
                "startedAt",
            )
        },
        untrusted_text=text,
        withheld=withheld,
        observed_at=_ts(a.get("completedAt") or a.get("startedAt")),
        link=f"/payments/{payment_id}",
    )


def _event_ev(e: dict, payment_id: str) -> Evidence:
    meta = e.get("metadata") or {}
    text, withheld = _untrusted(meta.get("message") or meta.get("reason"), 300)
    return Evidence(
        id=f"evt:{e['id']}",
        kind="payment_event",
        summary=f"Audit event #{e['sequence']} {e['eventType']} ({e.get('fromStatus') or '-'} -> {e.get('toStatus') or '-'}) from {e['source']}.",
        data={
            "eventType": e["eventType"],
            "sequence": e["sequence"],
            "fromStatus": e.get("fromStatus"),
            "toStatus": e.get("toStatus"),
            "source": e["source"],
            **{k: meta[k] for k in SAFE_EVENT_META if k in meta},
        },
        untrusted_text=text,
        withheld=withheld,
        observed_at=_ts(e.get("occurredAt")),
        link=f"/payments/{payment_id}",
    )


def _log_ev(entry: dict, limit: int) -> Evidence:
    text, withheld = _untrusted(entry.get("message"), limit)
    return Evidence(
        id=f"log:{entry['id']}",
        kind="log",
        summary=f"[{entry['level']}] log line from {entry['component']}.",
        data={"level": entry["level"], "component": entry["component"], "correlationId": entry.get("correlationId")},
        untrusted_text=text,
        withheld=withheld,
        observed_at=_ts(entry.get("occurredAt")),
        link=f"/payments/{entry['paymentId']}" if entry.get("paymentId") else None,
    )


def _disc_ev(d: dict) -> Evidence:
    return Evidence(
        id=f"disc:{d['id']}",
        kind="discrepancy",
        summary=f"Reconciliation discrepancy {d['type']} for {d['operation']} of {d['paymentReference']} ({d['status']}).",
        data={
            "type": d["type"],
            "operation": d["operation"],
            "internalAmount": d.get("internalAmount"),
            "internalCurrency": d.get("internalCurrency"),
            "reportAmount": d.get("reportAmount"),
            "reportCurrency": d.get("reportCurrency"),
            "status": d["status"],
            "paymentReference": d["paymentReference"],
        },
        observed_at=_ts(d.get("createdAt")),
        link="/reconciliation",
    )


def _anomaly_ev(a: dict) -> Evidence:
    return Evidence(
        id=f"anom:{a['id']}",
        kind="anomaly",
        summary=f"{a['severity']} anomaly: {a['metric']} on {a['dimension']} observed {a['observed']} vs baseline {a['baseline']} (threshold {a['threshold']}, method {a['method']}, n={a.get('sampleSize', '?')}).",
        data={
            k: a.get(k)
            for k in (
                "metric",
                "dimension",
                "observed",
                "baseline",
                "threshold",
                "score",
                "severity",
                "method",
                "sampleSize",
                "windowStart",
                "windowEnd",
            )
        },
        observed_at=_ts(a.get("detectedAt")),
        link="/incidents",
    )


def _stats_ev(s: dict, start: str, end: str) -> Evidence:
    lat = s.get("latency") or {}
    return Evidence(
        id=f"stat:{s['processor']}:{start[:16]}",
        kind="processor_stats",
        summary=(
            f"Processor {s['processor']}: {s['attempts']} attempts, failure rate {s['failureRate']}, timeout rate {s['timeoutRate']}, "
            f"p95 latency {lat.get('p95') if lat.get('sufficientSample') else 'n/a (sample too small)'} ms between {start} and {end}."
        ),
        data={
            "processor": s["processor"],
            "attempts": s["attempts"],
            "failureRate": s.get("failureRate"),
            "timeoutRate": s.get("timeoutRate"),
            "unavailable": s.get("unavailable"),
            "timeouts": s.get("timeouts"),
            "p95": lat.get("p95"),
            "p99": lat.get("p99"),
            "latencySample": lat.get("sampleSize"),
            "from": start,
            "to": end,
        },
        observed_at=_ts(end),
        link="/",
    )


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def processor_window_stats(reader: BackendReader, g: Gathered, processor: str, center: datetime, hours: int = 1) -> None:
    start, end = center - timedelta(hours=hours), min(center + timedelta(hours=hours), datetime.now(UTC))
    if end <= start:
        end = start + timedelta(minutes=5)
    stats = _try(g, "Processor statistics", lambda: reader.get("/api/v1/analytics/processors", {"from": _iso(start), "to": _iso(end)}))
    for s in stats or []:
        if s.get("processor") == processor:
            g.add(_stats_ev(s, _iso(start), _iso(end)))


def gather_payment(reader: BackendReader, payment_id: str, limit: int = 300) -> Gathered:
    g = Gathered()
    p = reader.get(f"/api/v1/payments/{payment_id}")  # BackendError(not_found/denied) propagates to the caller
    g.add(_payment_ev(p, limit))
    for a in p.get("attempts") or []:
        g.add(_attempt_ev(a, payment_id, limit))
    events = _try(g, "Payment audit events", lambda: reader.get(f"/api/v1/payments/{payment_id}/events", {"size": 50}))
    for e in (events or {}).get("items", []):
        g.add(_event_ev(e, payment_id))
    logs = _try(g, "Operational logs", lambda: reader.get("/api/v1/operational-logs", {"paymentId": payment_id, "size": 30}))
    for entry in (logs or {}).get("items", []):
        g.add(_log_ev(entry, limit))
    discs = _try(
        g,
        "Reconciliation discrepancies",
        lambda: reader.get("/api/v1/reconciliations/discrepancies", {"paymentReference": payment_id, "size": 10}),
    )
    for d in (discs or {}).get("items", []):
        g.add(_disc_ev(d))
    created = _ts(p.get("createdAt")) or datetime.now(UTC)
    processor_window_stats(reader, g, p["processor"], created)
    near = _try(
        g,
        "Anomalies",
        lambda: reader.get("/api/v1/anomalies", {"dimension": p["processor"], "since": _iso(created - timedelta(hours=6)), "size": 10}),
    )
    for a in (near or {}).get("items", []):
        ws, we = _ts(a.get("windowStart")), _ts(a.get("windowEnd"))
        if ws and we and ws <= created + timedelta(hours=1) and we >= created - timedelta(hours=1):
            g.add(_anomaly_ev(a))
    return g


def gather_anomaly(reader: BackendReader, anomaly_id: str, limit: int = 300) -> Gathered:
    g = Gathered()
    a = reader.get(f"/api/v1/anomalies/{anomaly_id}")
    g.add(_anomaly_ev(a))
    ws, we = _ts(a.get("windowStart")), _ts(a.get("windowEnd"))
    if ws and we:
        if a["dimension"] != "ALL":
            processor_window_stats(reader, g, a["dimension"], ws + (we - ws) / 2, hours=1)
        logs = _try(
            g,
            "Operational logs",
            lambda: reader.get("/api/v1/operational-logs", {"component": "processor-client", "from": _iso(ws), "to": _iso(we), "size": 20}),
        )
        for entry in (logs or {}).get("items", []):
            g.add(_log_ev(entry, limit))
        reasons = _try(
            g, "Failure reasons", lambda: reader.get("/api/v1/analytics/failure-reasons", {"from": _iso(ws), "to": _iso(we), "limit": 5})
        )
        for r in reasons or []:
            g.add(
                Evidence(
                    id=f"stat:reason:{r['reason']}:{_iso(ws)[:16]}",
                    kind="metric",
                    summary=f"Failure reason {r['reason']} ({r['category']}): {r['count']} attempts ({r['share']} share) in the anomaly window.",
                    data={"reason": r["reason"], "category": r["category"], "count": r["count"], "share": r["share"]},
                    observed_at=we,
                    link="/",
                )
            )
    return g


def gather_incident(reader: BackendReader, incident_id: str, limit: int = 300) -> tuple[Gathered, dict]:
    g = Gathered()
    detail = reader.get(f"/api/v1/incidents/{incident_id}")
    inc = detail["incident"]
    g.add(
        Evidence(
            id=f"inc:{inc['id']}",
            kind="incident",
            summary=f"Incident '{inc['title'][:120]}' is {inc['status']} (severity {inc['severity']}, source {inc['source']}), components {inc['components']}.",
            data={
                "status": inc["status"],
                "severity": inc["severity"],
                "source": inc["source"],
                "components": inc["components"],
                "startedAt": inc["startedAt"],
                "resolvedAt": inc.get("resolvedAt"),
            },
            observed_at=_ts(inc.get("startedAt")),
            link=f"/incidents/{inc['id']}",
        )
    )
    for a in detail.get("anomalies", []):
        g.add(_anomaly_ev({**a, "method": a.get("method", "?"), "threshold": a.get("threshold", "?")}))
    for d in detail.get("discrepancies", []):
        g.add(
            Evidence(
                id=f"disc:{d['id']}",
                kind="discrepancy",
                summary=f"Reconciliation discrepancy {d['type']} for {d['paymentReference']} ({d['status']}).",
                data={"type": d["type"], "status": d["status"], "paymentReference": d["paymentReference"]},
                observed_at=_ts(d.get("createdAt")),
                link="/reconciliation",
            )
        )
    for p in detail.get("payments", [])[:25]:
        g.add(
            Evidence(
                id=f"pay:{p['id']}",
                kind="payment",
                summary=f"Linked payment {p['id']} is {p['status']} ({p['amount']} {p['currency']}, {p['processor']}, failure code {p.get('failureCode') or 'none'}).",
                data={
                    "status": p["status"],
                    "amount": p["amount"],
                    "currency": p["currency"],
                    "processor": p["processor"],
                    "failureCode": p.get("failureCode"),
                },
                observed_at=_ts(p.get("createdAt")),
                link=f"/payments/{p['id']}",
            )
        )
    for t in [t for t in detail.get("timeline", []) if t["kind"] in {"LOG", "PAYMENT_EVENT"}][-30:]:
        if t["kind"] == "LOG":
            g.add(
                _log_ev(
                    {
                        "id": t["refId"],
                        "level": "WARN",
                        "component": t["title"],
                        "message": t.get("detail") or "",
                        "occurredAt": t["at"],
                        "paymentId": t.get("paymentId"),
                    },
                    limit,
                )
            )
        else:
            g.add(
                Evidence(
                    id=f"evt:{t['refId']}",
                    kind="payment_event",
                    summary=f"Audit event {t['title']}.",
                    data={"title": t["title"]},
                    observed_at=_ts(t["at"]),
                    link=f"/payments/{t['paymentId']}" if t.get("paymentId") else None,
                )
            )
    start, end = _ts(inc.get("startedAt")) or datetime.now(UTC), _ts(inc.get("resolvedAt")) or datetime.now(UTC)
    if end - start < timedelta(minutes=30):
        start = end - timedelta(minutes=30)
    for comp in inc.get("components", [])[:3]:
        processor_window_stats(reader, g, comp, start + (end - start) / 2, hours=max(1, int((end - start).total_seconds() // 7200) + 1))
    return g, detail


def budget(g: Gathered, max_items: int, max_chars: int) -> tuple[list[Evidence], int]:
    """Keeps the most useful evidence within the prompt budget: subject, attempts, anomalies, discrepancies and statistics
    first; then events and logs newest-first. Returns (kept, dropped_count)."""
    priority = {
        "payment": 0,
        "incident": 0,
        "anomaly": 1,
        "attempt": 1,
        "discrepancy": 2,
        "processor_stats": 2,
        "metric": 2,
        "payment_event": 3,
        "log": 4,
    }
    ordered = sorted(g.evidence, key=lambda e: (priority.get(e.kind, 5), -(e.observed_at.timestamp() if e.observed_at else 0)))
    kept: list[Evidence] = []
    used = 0
    for e in ordered:
        size = len(e.summary) + len(e.untrusted_text or "") + len(str(e.data)) + 40
        if len(kept) >= max_items or used + size > max_chars:
            continue
        kept.append(e)
        used += size
    return kept, len(ordered) - len(kept)
