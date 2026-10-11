from datetime import UTC, datetime, timedelta

import pytest

from app.anomaly import DEFAULT_CONFIGS, AnomalyRunner, MetricConfig, Point, densify, detect, severity_for
from tests.fakes import FakeBackend

T0 = datetime(2026, 10, 15, 0, 0, tzinfo=UTC)
H = 3600


def series(values, samples=50, start=T0):
    return [Point(start + timedelta(hours=i), v, samples if v is not None else 0) for i, v in enumerate(values)]


CFG = DEFAULT_CONFIGS["FAILURE_RATE"]
NOISY_BASELINE = [
    0.03,
    0.05,
    0.04,
    0.06,
    0.05,
    0.04,
    0.03,
    0.05,
    0.06,
    0.04,
    0.05,
    0.04,
    0.05,
    0.03,
    0.04,
    0.05,
    0.06,
    0.04,
    0.05,
    0.04,
    0.05,
    0.04,
    0.03,
    0.05,
]


def test_clear_spike_is_detected_with_full_context():
    res = detect("FAILURE_RATE", "MOCK_PROCESSOR_EU", series([*NOISY_BASELINE, 0.45]), H, CFG, evaluate_last=1)
    assert len(res.anomalies) == 1
    a = res.anomalies[0]
    assert (a.metric, a.dimension, a.direction, a.severity, a.method) == ("FAILURE_RATE", "MOCK_PROCESSOR_EU", "HIGH", "HIGH", "mad")
    assert a.observed == 0.45 and 0.03 < a.baseline < 0.06 and a.threshold < a.observed and a.score > 10 and a.sample_size == 50
    assert a.window_end - a.window_start == timedelta(hours=1) and a.details["baselinePoints"] == 24


def test_normal_noise_does_not_alert():
    res = detect("FAILURE_RATE", "ALL", series([*NOISY_BASELINE, 0.07, 0.02, 0.06]), H, CFG, evaluate_last=3)
    assert res.anomalies == [] and res.evaluated == 3


def test_flat_baseline_does_not_make_tiny_changes_infinitely_significant():
    flat = [0.05] * 24  # MAD = 0
    assert detect("FAILURE_RATE", "ALL", series([*flat, 0.06]), H, CFG, 1).anomalies == []  # below min_abs_delta and below k * scale-floor
    assert len(detect("FAILURE_RATE", "ALL", series([*flat, 0.40]), H, CFG, 1).anomalies) == 1


def test_low_volume_buckets_are_skipped_not_flagged():
    pts = series(NOISY_BASELINE) + [Point(T0 + timedelta(hours=24), 1.0, 2)]  # 2 of 2 attempts failed: meaningless
    res = detect("FAILURE_RATE", "ALL", pts, H, CFG, 1)
    assert res.anomalies == [] and res.skipped == {"low_volume": 1}


def test_zero_denominator_and_short_history_are_handled():
    res = detect("FAILURE_RATE", "ALL", [*series(NOISY_BASELINE), Point(T0 + timedelta(hours=24), None, 0)], H, CFG, 1)
    assert res.anomalies == [] and res.skipped == {"no_data": 1}
    res2 = detect("FAILURE_RATE", "ALL", series([0.05, 0.05, 0.9]), H, CFG, 1)
    assert res2.anomalies == [] and res2.skipped == {"insufficient_history": 1}
    assert detect("FAILURE_RATE", "ALL", [], H, CFG).evaluated == 0


def test_low_volume_history_buckets_do_not_pollute_the_baseline():
    hist = [
        Point(T0 + timedelta(hours=i), 1.0 if i % 2 else 0.05, 2 if i % 2 else 60) for i in range(24)
    ]  # odd hours: 2 samples, 100% "failure"
    pts = [*hist, Point(T0 + timedelta(hours=24), 0.45, 60)]
    a = detect("FAILURE_RATE", "ALL", pts, H, CFG, 1).anomalies
    assert len(a) == 1 and a[0].baseline == pytest.approx(0.05)


def test_robust_to_a_few_contaminating_outliers_in_the_window():
    contaminated = list(NOISY_BASELINE)
    contaminated[10:13] = [0.9, 0.9, 0.9]
    assert len(detect("FAILURE_RATE", "ALL", series([*contaminated, 0.45]), H, CFG, 1).anomalies) == 1, (
        "MAD keeps the baseline sane despite earlier incidents"
    )
    z = MetricConfig(method="zscore")
    assert detect("FAILURE_RATE", "ALL", series([*contaminated, 0.45]), H, z, 1).anomalies == [], (
        "documented weakness of mean/std baselines"
    )


def test_latency_and_count_metrics_and_directions():
    lat = [118, 120, 119, 125, 117, 121, 119, 122] * 3
    res = detect("PROCESSOR_LATENCY_P95", "MOCK_PROCESSOR", series([*lat, 1000]), H, DEFAULT_CONFIGS["PROCESSOR_LATENCY_P95"], 1)
    assert res.anomalies and res.anomalies[0].severity == "HIGH"
    thr = [40, 42, 38, 41, 39, 43, 40, 41] * 3
    drop = detect("THROUGHPUT", "ALL", series([*thr, 2], samples=0), H, DEFAULT_CONFIGS["THROUGHPUT"], 1)
    assert drop.anomalies and drop.anomalies[0].direction == "LOW"
    assert detect("FAILURE_RATE", "ALL", series([*NOISY_BASELINE, 0.0]), H, CFG, 1).anomalies == [], (
        "a drop in failure rate is good news, not an alert"
    )


def test_severity_bands():
    assert [severity_for(s, 4) for s in (4, 6, 10, -12)] == ["LOW", "MEDIUM", "HIGH", "HIGH"]


def test_densify_fills_count_metrics_with_zero_but_leaves_rate_gaps_empty():
    raw = [{"bucketStart": "2026-10-15T01:00:00Z", "value": 5, "sampleSize": 5}]
    counts = densify(raw, T0, T0 + timedelta(hours=3), H, True)
    assert [p.value for p in counts] == [0.0, 5.0, 0.0]
    rates = densify(raw, T0, T0 + timedelta(hours=3), H, False)
    assert [p.value for p in rates] == [None, 5.0, None]


class Sink:
    def __init__(self):
        self.stored = []

    def store(self, items):
        self.stored += items
        return [{"id": f"id-{i}", "created": True} for i, _ in enumerate(items)]


def runner_backend(spike: bool):
    now = datetime(2026, 10, 15, 6, 30, tzinfo=UTC)
    start = datetime(2026, 10, 15, 6, 0, tzinfo=UTC) + timedelta(hours=1) - timedelta(hours=32)

    def timeseries(params):
        metric = params["metric"]
        pts = []
        for i in range(31):
            t = start + timedelta(hours=i)
            if metric == "FAILURE_RATE":
                v = 0.05 + 0.01 * (i % 3) - 0.01
                if spike and i >= 29 and params.get("processor") == "MOCK_PROCESSOR_EU":
                    v = 0.5
                pts.append({"bucketStart": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "value": round(v, 4), "sampleSize": 40})
            elif metric == "PROCESSOR_LATENCY_P95":
                pts.append({"bucketStart": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "value": 120 + (i % 4), "sampleSize": 40})
        return {"metric": metric, "points": pts}

    b = FakeBackend(
        {
            r"/api/v1/analytics/timeseries": timeseries,
            r"/api/v1/analytics/processors": [{"processor": "MOCK_PROCESSOR"}, {"processor": "MOCK_PROCESSOR_EU"}],
        }
    )
    return b, now


def test_runner_detects_per_processor_and_persists_idempotent_payloads():
    b, now = runner_backend(spike=True)
    sink = Sink()
    out = AnomalyRunner(now=lambda: now).run(b, sink, metrics=["FAILURE_RATE", "PROCESSOR_LATENCY_P95"], evaluate_last=3)  # type: ignore[arg-type]
    assert out["dimensions"] == ["ALL", "MOCK_PROCESSOR", "MOCK_PROCESSOR_EU"]
    eu = [a for a in out["anomalies"] if a["dimension"] == "MOCK_PROCESSOR_EU"]
    assert eu and all(a["metric"] == "FAILURE_RATE" and a["severity"] == "HIGH" for a in eu)
    assert not [a for a in out["anomalies"] if a["dimension"] == "MOCK_PROCESSOR"]
    assert len(sink.stored) == len(out["anomalies"]) and sink.stored[0]["windowEnd"] > sink.stored[0]["windowStart"]
    assert out["anomalies"][0]["id"] == "id-0" and out["persisted"] is True


def test_runner_without_a_spike_reports_nothing_and_does_not_persist():
    b, now = runner_backend(spike=False)
    sink = Sink()
    out = AnomalyRunner(now=lambda: now).run(b, sink, metrics=["FAILURE_RATE"], evaluate_last=3)  # type: ignore[arg-type]
    assert out["anomalies"] == [] and sink.stored == [] and out["evaluated"] > 0


def test_runner_validates_metric_selection():
    b, now = runner_backend(spike=False)
    with pytest.raises(ValueError):
        AnomalyRunner(now=lambda: now).run(b, None, metrics=["NOT_A_METRIC"])  # type: ignore[arg-type]
