"""Deterministic text built only from query results. Used when no model explanation is available (and by the mock)."""

from __future__ import annotations

from typing import Any


def template_explanation(results: dict[str, Any]) -> str:
    """Deterministic explanation built only from the numbers in the results (used when no LLM answer is available)."""
    lines: list[str] = []
    pct = lambda v: "n/a" if v is None else f"{float(v) * 100:.1f}%"  # noqa: E731
    for opid, r in results.items():
        d, name = r["data"], r["name"]
        if name == "processor_stats" and d:
            worst = max(d, key=lambda p: float(p.get("failureRate") or 0))
            lines.append(
                f"{opid}: highest failure rate is {worst['processor']} at {pct(worst.get('failureRate'))} over {worst['attempts']} attempts; "
                + "; ".join(f"{p['processor']} {pct(p.get('failureRate'))}" for p in d)
                + "."
            )
        elif name == "failure_reasons" and d:
            lines.append(f"{opid}: most common non-success reasons: " + ", ".join(f"{x['reason']} ({x['count']})" for x in d[:5]) + ".")
        elif name == "overview":
            t = d["totals"]
            lines.append(
                f"{opid}: {t['total']} payments, {t['successful']} successful, {t['failed']} failed, {t['uncertain']} uncertain; success rate {pct(d.get('successRate'))}."
            )
        elif name == "payment_trends" and d:
            worst = max(d, key=lambda p: float(p.get("failureRate") or 0))
            lines.append(f"{opid}: peak failure rate {pct(worst.get('failureRate'))} in the bucket starting {worst['bucketStart']}.")
        elif name == "timeseries":
            vals = [p for p in d.get("points", []) if p.get("value") is not None]
            if vals:
                peak = max(vals, key=lambda p: float(p["value"]))
                lines.append(f"{opid}: {d['metric']} peaks at {peak['value']} in the bucket starting {peak['bucketStart']}.")
        elif name == "open_discrepancies":
            lines.append(f"{opid}: {d.get('totalItems', 0)} discrepancies match the filter.")
        elif name == "recent_anomalies":
            lines.append(f"{opid}: {d.get('totalItems', 0)} anomalies recorded in the window.")
    return " ".join(lines) or "The queries returned no data for the requested window."
