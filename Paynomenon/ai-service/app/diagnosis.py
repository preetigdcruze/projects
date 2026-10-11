"""Deterministic, rule-based diagnosis over retrieved evidence.

This is not the LLM. It produces (a) `findings` shown to users even when no model is reachable and (b) the reasoning
behind the mock provider used in development and tests. Every statement cites evidence ids that exist.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .models import Evidence, Finding


@dataclass
class Diagnosis:
    label: str
    statement: str
    evidence_ids: list[str]
    confidence: str
    confidence_explanation: str
    alternatives: list[tuple[str, list[str], str]] = field(default_factory=list)  # (statement, ids, likelihood)
    steps: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    insufficient: bool = False
    findings: list[Finding] = field(default_factory=list)


def _by_kind(ev: list[Evidence], kind: str) -> list[Evidence]:
    return [e for e in ev if e.kind == kind]


def runbook_query(label: str) -> str:
    return {
        "processor_timeout": "timeout uncertain processor",
        "processor_unavailable": "unavailable circuit breaker outage",
        "insufficient_funds": "declines insufficient funds",
        "invalid_request": "declines failure rate",
        "reconciliation_discrepancy": "reconciliation mismatch settlement",
        "latency_anomaly": "latency degradation p95",
        "failure_rate_anomaly": "declines failure rate",
        "dead_letter": "dead letter replay",
    }.get(label, "")


STEPS = {
    "processor_timeout": [
        "Check whether a ProcessorTimeout event was published and consumed (System Health: outbox backlog, dead-letter count).",
        "Confirm the processor's own record of the request id before treating the payment as failed.",
        "Review processor latency percentiles around the incident time for a degradation that precedes the timeouts.",
    ],
    "processor_unavailable": [
        "Check the processor circuit state and the unavailable/rejected attempt counts on System Health.",
        "Compare the other processor to decide whether the outage is processor-specific.",
        "After recovery, the client can authorize the payment again; it was never reached.",
    ],
    "insufficient_funds": [
        "No platform fault is indicated: the processor declined for insufficient funds.",
        "Check whether many declines come from one merchant or a test run before escalating.",
    ],
    "invalid_request": [
        "Inspect the request fields sent to the processor (amount, currency, reference) for a malformed value.",
        "Check recent deployments that changed request construction.",
    ],
    "reconciliation_discrepancy": [
        "Compare internal and report amount/currency for the payment in the discrepancy record.",
        "Review the payment's audit events for refunds or partial operations that explain a difference.",
        "Acknowledge the discrepancy with an explanation only after the cause is understood; do not edit ledger entries.",
    ],
    "latency_anomaly": [
        "Compare p95 latency for this processor against its baseline in the anomaly record.",
        "Check for rising timeout counts and bulkhead rejections that would confirm saturation.",
    ],
    "failure_rate_anomaly": [
        "Break the failure rate down by failure reason to separate declines from infrastructure faults.",
        "Check processor availability and circuit breaker transitions in the same window.",
    ],
    "healthy": ["No failure is visible in the retrieved evidence; verify the question refers to the right payment."],
}


def diagnose(evidence: list[Evidence], subject_type: str, gaps: list[str] | None = None) -> Diagnosis:
    gaps = gaps or []
    attempts = sorted(_by_kind(evidence, "attempt"), key=lambda e: e.data.get("attemptNumber", 0))
    events = _by_kind(evidence, "payment_event")
    logs = _by_kind(evidence, "log")
    discrepancies = _by_kind(evidence, "discrepancy")
    anomalies = _by_kind(evidence, "anomaly")
    payments = _by_kind(evidence, "payment")
    stats = _by_kind(evidence, "processor_stats")
    missing = list(gaps)
    if not logs and not any("log" in g.lower() for g in gaps):
        missing.append("No operational log lines were found for this subject.")
    if not stats:
        missing.append("No processor metrics were available for the time window.")

    findings: list[Finding] = []
    ids = lambda items: [e.id for e in items]  # noqa: E731

    timeout_att = [a for a in attempts if a.data.get("status") == "TIMEOUT"]
    unavailable_att = [a for a in attempts if a.data.get("status") == "UNAVAILABLE"]
    declined_att = [a for a in attempts if a.data.get("status") == "DECLINED"]
    invalid_att = [a for a in attempts if a.data.get("status") == "INVALID"]
    uncertain_events = [e for e in events if e.data.get("eventType") == "OUTCOME_UNCERTAIN"]
    resolved_events = [e for e in events if e.data.get("eventType") == "OUTCOME_RESOLVED"]
    pay = payments[0] if payments else None

    for a in attempts:
        findings.append(
            Finding(
                text=f"{a.data.get('operation')} attempt {a.data.get('attemptNumber')} ended {a.data.get('status')}"
                f"{' with code ' + str(a.data['responseCode']) if a.data.get('responseCode') else ''}.",
                evidenceIds=[a.id],
            )
        )
    for d in discrepancies:
        findings.append(Finding(text=f"Reconciliation recorded {d.data.get('type')} ({d.data.get('status')}).", evidenceIds=[d.id]))
    for an in anomalies:
        findings.append(
            Finding(
                text=f"Statistical anomaly: {an.data.get('metric')} on {an.data.get('dimension')} observed {an.data.get('observed')} vs baseline {an.data.get('baseline')}.",
                evidenceIds=[an.id],
            )
        )

    def make(
        label: str, statement: str, cite: list[str], conf: str, why: str, alts: list[tuple[str, list[str], str]] | None = None
    ) -> Diagnosis:
        return Diagnosis(label, statement, cite, conf, why, alts or [], STEPS.get(label, []), missing, False, findings)

    if subject_type == "ANOMALY" and anomalies:
        an = anomalies[0]
        metric = str(an.data.get("metric"))
        label = "latency_anomaly" if "LATENCY" in metric else "failure_rate_anomaly"
        corroborating = [s for s in stats if s.data.get("processor") == an.data.get("dimension")]
        cite = [an.id] + ids(corroborating[:1]) + ids(logs[:2])
        conf = "high" if corroborating and len(cite) >= 3 else "medium"
        return make(
            label,
            f"{metric} on {an.data.get('dimension')} deviated from its rolling baseline ({an.data.get('observed')} observed vs {an.data.get('baseline')} baseline).",
            cite,
            conf,
            "The detector's observed value, baseline and threshold are recorded facts"
            + (
                "; processor statistics for the same window point the same way."
                if corroborating
                else "; no corroborating statistics were retrieved."
            ),
            [("The deviation may be a short-lived spike of low volume rather than a sustained degradation.", [an.id], "low")],
        )
    if subject_type == "INCIDENT":
        failing = [e for e in evidence if e.kind == "payment" and e.data.get("status") in {"FAILED", "UNCERTAIN"}]
        if anomalies or discrepancies or failing:
            cite = ids(anomalies[:2]) + ids(discrepancies[:2]) + ids(failing[:3]) + ids(stats[:1])
            label = (
                "reconciliation_discrepancy"
                if discrepancies and not anomalies
                else ("latency_anomaly" if any("LATENCY" in str(a.data.get("metric")) for a in anomalies) else "failure_rate_anomaly")
            )
            conf = "medium" if len(cite) >= 2 else "low"
            return make(
                label,
                "The linked anomalies, discrepancies and failed payments point to a problem concentrated on the affected component.",
                cite or ids(evidence[:1]),
                conf,
                f"{len(cite)} linked records agree on the affected component; root cause is not directly observed.",
            )
        return Diagnosis(
            "insufficient",
            "The incident has no linked records that explain it.",
            [],
            "low",
            "Nothing linked to the incident could be retrieved.",
            [],
            [],
            missing,
            True,
            findings,
        )
    if not pay and not attempts and not events:
        return Diagnosis(
            "insufficient",
            "No evidence about this subject could be retrieved.",
            [],
            "low",
            "No records were retrieved.",
            [],
            [],
            missing,
            True,
            findings,
        )

    if timeout_att or (pay and pay.data.get("status") == "UNCERTAIN") or uncertain_events:
        cite = ids(timeout_att[:2]) + ids(uncertain_events[:1]) + ids(resolved_events[:1]) + ids(logs[:2]) + ids(stats[:1])
        cite = cite or ids(attempts[:1])
        kinds = {e.kind for e in evidence if e.id in cite}
        conf = "high" if len(kinds) >= 3 else "medium"
        outcome = " It was later resolved by a processor lookup." if resolved_events else ""
        return make(
            "processor_timeout",
            "The processor did not answer within the deadline, so the outcome of the operation was unknown (ambiguous timeout)." + outcome,
            cite,
            conf,
            f"{len(kinds)} independent evidence types ({', '.join(sorted(kinds))}) are consistent with an ambiguous processor timeout.",
            [
                (
                    "Elevated processor latency preceding the deadline, rather than an outage.",
                    ids(stats[:1]) or ids(timeout_att[:1]),
                    "medium" if stats else "low",
                ),
                ("A network problem between PaySense and the processor.", ids(logs[:1]) or ids(timeout_att[:1]), "low"),
            ],
        )
    if unavailable_att:
        cite = ids(unavailable_att[:2]) + ids(logs[:2]) + ids(stats[:1])
        kinds = {e.kind for e in evidence if e.id in cite}
        return make(
            "processor_unavailable",
            "The processor was unavailable (or its circuit breaker was open), so the request was never executed.",
            cite,
            "high" if len(kinds) >= 2 else "medium",
            "Unavailable attempts are provably not executed; the logs and statistics, where present, agree.",
            [
                (
                    "A deployment or configuration problem on our side that blocked outbound calls.",
                    ids(logs[:1]) or ids(unavailable_att[:1]),
                    "low",
                )
            ],
        )
    if declined_att:
        code = declined_att[-1].data.get("responseCode")
        cite = ids(declined_att[-1:]) + ids(events[-1:])
        return make(
            "insufficient_funds" if code == "INSUFFICIENT_FUNDS" else "invalid_request",
            f"The processor declined the operation with code {code}.",
            cite,
            "high" if len(cite) >= 2 else "medium",
            "The processor's response code is recorded on the attempt and the audit trail.",
            [("The decline is a customer-side outcome and not a platform fault.", ids(declined_att[-1:]), "medium")]
            if code == "INSUFFICIENT_FUNDS"
            else [],
        )
    if invalid_att:
        return make(
            "invalid_request",
            "The processor rejected the request as invalid.",
            ids(invalid_att[-1:]) + ids(events[-1:]),
            "medium",
            "The attempt status INVALID is recorded; the offending field is not visible in the evidence.",
        )
    if discrepancies:
        d = discrepancies[0]
        return make(
            "reconciliation_discrepancy",
            f"Reconciliation recorded a {d.data.get('type')} for this payment.",
            ids(discrepancies[:2]) + ids(payments[:1]),
            "medium",
            "The discrepancy record lists the compared values.",
        )
    if pay and pay.data.get("status") in {"AUTHORIZED", "CAPTURED", "REFUNDED"}:
        return make(
            "healthy",
            f"No failure is visible: the payment is {pay.data.get('status')} and its attempts succeeded.",
            ids(payments[:1]) + ids(attempts[:2]),
            "medium",
            "The payment state and attempts show no failure.",
        )
    return Diagnosis(
        "insufficient",
        "The retrieved evidence does not explain the question.",
        ids(payments[:1]),
        "low",
        "The evidence is incomplete.",
        [],
        [],
        missing,
        True,
        findings,
    )
