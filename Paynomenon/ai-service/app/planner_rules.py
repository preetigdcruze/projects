"""Keyword planner: maps common operator questions to predefined analytics operations without any model.

Used (a) as the fallback when no LLM is reachable and (b) by the deterministic mock provider."""

from __future__ import annotations

import re
from typing import Any


def detect_window(q: str) -> str:
    q = q.lower()
    if re.search(r"last\s+(1\s+)?hour|past\s+hour|previous\s+hour|\bhour\b", q):
        return "last_hour"
    if re.search(r"last\s+6\s+hours|past\s+6\s+hours|six hours", q):
        return "last_6_hours"
    if "today" in q:
        return "today"
    if re.search(r"last\s+(7|seven)\s+days|past\s+week|this\s+week|last week", q):
        return "last_7_days"
    if re.search(r"last\s+(30|thirty)\s+days|past\s+month|this month", q):
        return "last_30_days"
    return "last_24_hours"


def detect_processor(q: str) -> str | None:
    m = re.search(r"\b(MOCK_PROCESSOR(?:_EU)?)\b", q, re.I)
    return m.group(1).upper() if m else None


def rules_plan(question: str) -> dict[str, Any]:
    q = question.lower()
    if re.search(
        r"\b(select|insert|update|delete|drop|alter|truncate|exec)\b.*\b(from|into|table|set|database)\b|;\s*--|\bunion\s+select\b", q
    ):
        return {"operations": [], "reason": "Free-form queries are not supported; only predefined analytics operations can be run."}
    w = detect_window(question)
    proc = detect_processor(question)
    ops: list[dict[str, Any]] = []

    def add(name: str, **args: Any) -> None:
        ops.append({"name": name, "args": {"window": w, **{k: v for k, v in args.items() if v is not None}}})

    if re.search(r"discrepanc|reconcil|settlement|mismatch", q):
        ops.append({"name": "open_discrepancies", "args": {"status": "OPEN"}})
    elif re.search(r"anomal|unusual|abnormal", q) and not re.search(r"latency|slow", q):
        add("recent_anomalies", processor=proc)
    elif re.search(r"latenc|slow|response time|p9[59]", q):
        add("processor_stats")
        add("timeseries", metric="PROCESSOR_LATENCY_P95", processor=proc)
    elif re.search(r"increas|spike|rise|rising|jump|more failures|went up|why", q) and re.search(r"fail|declin|error", q):
        add("payment_trends")
        add("failure_reasons", limit=5)
        add("processor_stats")
    elif re.search(r"highest|worst|which processor|compare|processors?", q):
        add("processor_stats")
    elif re.search(r"cause|reason|why|common", q):
        add("failure_reasons", limit=10)
    elif re.search(r"overview|how many|total|volume|success rate|summary|payments", q):
        add("overview")
    if not ops:
        return {"operations": [], "reason": "The question does not match any supported analytics operation."}
    return {"operations": ops[:3], "reason": "keyword match"}
