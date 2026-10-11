"""Statistical anomaly detection. No LLM is involved in deciding *whether* something is anomalous.

Method: for every evaluated bucket, take the preceding `window` buckets that have enough samples as the baseline and
compare with a robust z-score built from the median and the median absolute deviation (MAD). MAD is insensitive to the
few anomalous buckets that inevitably sit inside a rolling window, unlike mean/standard deviation (also provided).

Safeguards: minimum history, minimum samples per bucket (so one failure out of two payments is not "50% failure rate"),
a floor on the scale (a perfectly flat baseline has MAD 0, which would otherwise make any change infinite), a minimum
absolute/relative effect size, and null-handling for zero denominators."""

from __future__ import annotations

import logging
import statistics
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from .backend_client import AnomalySink, BackendError, BackendReader

log = logging.getLogger("paysense.ai.anomaly")

Direction = Literal["HIGH", "LOW"]
Severity = Literal["LOW", "MEDIUM", "HIGH"]
COUNT_METRICS = {"THROUGHPUT", "DISCREPANCY_COUNT"}  # a missing bucket means zero events, not "unknown"
BUCKET_SECONDS = {"MINUTE_5": 300, "MINUTE_15": 900, "HOUR": 3600, "DAY": 86400}


@dataclass(frozen=True)
class MetricConfig:
    window: int = 24  # baseline length in buckets
    min_baseline_points: int = 8
    k: float = 4.0  # robust z-score threshold
    min_scale: float = 0.02  # floor for the scale, in metric units
    min_abs_delta: float = 0.10  # smallest change worth reporting, in metric units
    min_rel_delta: float = 0.0  # ... or relative to the baseline median
    min_samples: int = 10  # observations needed in a bucket for its value to count
    directions: tuple[Direction, ...] = ("HIGH",)
    method: Literal["mad", "zscore"] = "mad"


DEFAULT_CONFIGS: dict[str, MetricConfig] = {
    "FAILURE_RATE": MetricConfig(min_scale=0.02, min_abs_delta=0.10, min_samples=10),
    "TIMEOUT_RATE": MetricConfig(min_scale=0.01, min_abs_delta=0.05, min_samples=10),
    "PROCESSOR_LATENCY_P95": MetricConfig(min_scale=15.0, min_abs_delta=150.0, min_samples=10),
    "THROUGHPUT": MetricConfig(min_scale=2.0, min_abs_delta=5.0, min_rel_delta=0.5, min_samples=0, directions=("HIGH", "LOW")),
    "DISCREPANCY_COUNT": MetricConfig(min_scale=1.0, min_abs_delta=3.0, min_samples=0),
}


@dataclass(frozen=True)
class Point:
    bucket_start: datetime
    value: float | None
    sample_size: int


@dataclass
class Anomaly:
    metric: str
    dimension: str
    window_start: datetime
    window_end: datetime
    observed: float
    baseline: float
    threshold: float
    score: float
    direction: Direction
    severity: Severity
    method: str
    sample_size: int
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class DetectionResult:
    anomalies: list[Anomaly] = field(default_factory=list)
    evaluated: int = 0
    skipped: dict[str, int] = field(default_factory=dict)

    def skip(self, reason: str) -> None:
        self.skipped[reason] = self.skipped.get(reason, 0) + 1


def _scale(values: list[float], cfg: MetricConfig) -> tuple[float, float, float]:
    """Returns (center, raw_dispersion, scale) with the scale floored."""
    if cfg.method == "mad":
        med = statistics.median(values)
        mad = statistics.median(abs(v - med) for v in values)
        return med, mad, max(1.4826 * mad, cfg.min_scale)
    mean = statistics.fmean(values)
    std = statistics.pstdev(values)
    return mean, std, max(std, cfg.min_scale)


def severity_for(score: float, k: float) -> Severity:
    s = abs(score)
    return "HIGH" if s >= 2.5 * k else "MEDIUM" if s >= 1.5 * k else "LOW"


def detect(
    metric: str, dimension: str, points: list[Point], bucket_seconds: int, cfg: MetricConfig, evaluate_last: int = 6
) -> DetectionResult:
    """Evaluate the last `evaluate_last` buckets against their own rolling baselines."""
    result = DetectionResult()
    points = sorted(points, key=lambda p: p.bucket_start)
    start = max(0, len(points) - evaluate_last)
    for i in range(start, len(points)):
        p = points[i]
        result.evaluated += 1
        if p.value is None:
            result.skip("no_data")  # zero denominator: there is nothing to compare
            continue
        if p.sample_size < cfg.min_samples:
            result.skip("low_volume")
            continue
        history = [q.value for q in points[max(0, i - cfg.window) : i] if q.value is not None and q.sample_size >= cfg.min_samples]
        if len(history) < cfg.min_baseline_points:
            result.skip("insufficient_history")
            continue
        center, dispersion, scale = _scale([float(v) for v in history], cfg)
        score = (float(p.value) - center) / scale
        delta = abs(float(p.value) - center)
        if delta < max(cfg.min_abs_delta, cfg.min_rel_delta * abs(center)):
            continue
        direction: Direction | None = (
            "HIGH" if score >= cfg.k and "HIGH" in cfg.directions else "LOW" if score <= -cfg.k and "LOW" in cfg.directions else None
        )
        if direction is None:
            continue
        threshold = center + cfg.k * scale if direction == "HIGH" else center - cfg.k * scale
        result.anomalies.append(
            Anomaly(
                metric,
                dimension,
                p.bucket_start,
                p.bucket_start + timedelta(seconds=bucket_seconds),
                float(p.value),
                center,
                threshold,
                score,
                direction,
                severity_for(score, cfg.k),
                cfg.method,
                p.sample_size,
                {
                    "baselinePoints": len(history),
                    "dispersion": dispersion,
                    "scale": scale,
                    "k": cfg.k,
                    "window": cfg.window,
                    "bucketSeconds": bucket_seconds,
                },
            )
        )
    return result


def densify(points: list[dict[str, Any]], start: datetime, end: datetime, bucket_seconds: int, count_metric: bool) -> list[Point]:
    """Aligns backend points to a regular grid. Count metrics get explicit zeros; rate metrics keep gaps as no-data."""
    by_start = {datetime.fromisoformat(p["bucketStart"].replace("Z", "+00:00")).astimezone(UTC): p for p in points}
    out: list[Point] = []
    t = start
    while t < end:
        p = by_start.get(t)
        if p is not None:
            out.append(Point(t, None if p.get("value") is None else float(p["value"]), int(p.get("sampleSize", 0))))
        elif count_metric:
            out.append(Point(t, 0.0, 0))
        else:
            out.append(Point(t, None, 0))
        t += timedelta(seconds=bucket_seconds)
    return out


def _floor(dt: datetime, seconds: int) -> datetime:
    return datetime.fromtimestamp((int(dt.timestamp()) // seconds) * seconds, tz=UTC)


class AnomalyRunner:
    def __init__(self, configs: dict[str, MetricConfig] | None = None, now: Any = None):
        self.configs = {**DEFAULT_CONFIGS, **(configs or {})}
        self._now = now or (lambda: datetime.now(UTC))

    def run(
        self,
        reader: BackendReader,
        sink: AnomalySink | None,
        bucket: str = "HOUR",
        metrics: list[str] | None = None,
        processors: list[str] | None = None,
        evaluate_last: int = 6,
        to: datetime | None = None,
        persist: bool = True,
    ) -> dict[str, Any]:
        seconds = BUCKET_SECONDS[bucket]
        end = _floor(to or self._now(), seconds) + timedelta(seconds=seconds)  # include the current (partial) bucket
        chosen = [m for m in (metrics or list(self.configs)) if m in self.configs]
        if not chosen:
            raise ValueError("no supported metrics selected")
        dims = ["ALL", *(processors or self._processors(reader, end))]
        found: list[Anomaly] = []
        summary: dict[str, Any] = {"evaluated": 0, "skipped": {}, "errors": []}
        for metric in chosen:
            cfg = self.configs[metric]
            start = end - timedelta(seconds=seconds * (cfg.window + evaluate_last + 1))
            for dim in dims:
                try:
                    series = reader.get(
                        "/api/v1/analytics/timeseries",
                        {
                            "metric": metric,
                            "bucket": bucket,
                            "from": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                            "to": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
                            "processor": None if dim == "ALL" else dim,
                        },
                    )
                except BackendError as e:
                    summary["errors"].append(f"{metric}/{dim}: {e.kind}")
                    continue
                pts = densify(series["points"], start, end, seconds, metric in COUNT_METRICS)
                res = detect(metric, dim, pts, seconds, cfg, evaluate_last)
                summary["evaluated"] += res.evaluated
                for reason, n in res.skipped.items():
                    summary["skipped"][reason] = summary["skipped"].get(reason, 0) + n
                found += res.anomalies
        stored: list[dict[str, Any]] = []
        if persist and sink and found:
            stored = sink.store([_payload(a) for a in found])
        out = []
        for i, a in enumerate(found):
            d = asdict(a)
            d["windowStart"], d["windowEnd"] = a.window_start.isoformat(), a.window_end.isoformat()
            d.pop("window_start"), d.pop("window_end")
            if i < len(stored):
                d["id"], d["created"] = stored[i]["id"], stored[i]["created"]
            out.append(d)
        return {
            "status": "COMPLETED",
            "bucket": bucket,
            "range": {
                "from": (end - timedelta(seconds=seconds * (self.configs[chosen[0]].window + evaluate_last + 1))).isoformat(),
                "to": end.isoformat(),
            },
            "metrics": chosen,
            "dimensions": dims,
            "evaluated": summary["evaluated"],
            "skipped": summary["skipped"],
            "errors": summary["errors"],
            "anomalies": out,
            "persisted": bool(persist and sink),
        }

    def _processors(self, reader: BackendReader, end: datetime) -> list[str]:
        try:
            rows = reader.get(
                "/api/v1/analytics/processors",
                {"from": (end - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ"), "to": end.strftime("%Y-%m-%dT%H:%M:%SZ")},
            )
            return sorted({r["processor"] for r in rows})
        except BackendError:
            return []


def _payload(a: Anomaly) -> dict[str, Any]:
    r = lambda x: round(float(x), 6)  # noqa: E731
    return {
        "metric": a.metric,
        "dimension": a.dimension,
        "windowStart": a.window_start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "windowEnd": a.window_end.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "observed": r(a.observed),
        "baseline": r(a.baseline),
        "threshold": r(a.threshold),
        "score": r(a.score),
        "direction": a.direction,
        "severity": a.severity,
        "method": a.method,
        "sampleSize": a.sample_size,
        "details": a.details,
    }
