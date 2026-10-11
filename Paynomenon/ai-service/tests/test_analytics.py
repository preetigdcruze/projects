from datetime import UTC, datetime

import pytest

from app.analytics_agent import OPERATIONS, AnalyticsAgent, PlanError, resolve_window, validate_plan
from app.config import Settings
from app.models import AnalyticsPlan
from app.planner_rules import rules_plan
from app.providers.mock import MockProvider
from tests import fakes
from tests.fakes import FakeBackend

NOW = datetime(2026, 10, 15, 12, 0, 0, tzinfo=UTC)

PROCESSORS = [
    {
        "processor": "MOCK_PROCESSOR",
        "attempts": 200,
        "approved": 190,
        "declined": 8,
        "invalid": 0,
        "unavailable": 1,
        "timeouts": 1,
        "failureRate": 0.05,
        "timeoutRate": 0.005,
        "latency": {"p50": 90, "p95": 130, "p99": 200, "sampleSize": 199, "sufficientSample": True, "minSample": 20},
    },
    {
        "processor": "MOCK_PROCESSOR_EU",
        "attempts": 180,
        "approved": 140,
        "declined": 20,
        "invalid": 2,
        "unavailable": 10,
        "timeouts": 8,
        "failureRate": 0.2222,
        "timeoutRate": 0.0444,
        "latency": {"p50": 95, "p95": 140, "p99": 300, "sampleSize": 170, "sufficientSample": True, "minSample": 20},
    },
]
REASONS = [
    {"reason": "INSUFFICIENT_FUNDS", "category": "DECLINED", "count": 28, "share": 0.6},
    {"reason": "TIMEOUT", "category": "TIMEOUT", "count": 9, "share": 0.2},
]
TRENDS = [
    {"bucketStart": "2026-10-15T10:00:00Z", "total": 50, "successful": 48, "failed": 2, "uncertain": 0, "failureRate": 0.04},
    {"bucketStart": "2026-10-15T11:00:00Z", "total": 50, "successful": 30, "failed": 20, "uncertain": 0, "failureRate": 0.4},
]


def backend(**kw) -> FakeBackend:
    return FakeBackend(
        {
            r"/api/v1/analytics/processors": PROCESSORS,
            r"/api/v1/analytics/failure-reasons": REASONS,
            r"/api/v1/analytics/payment-trends": TRENDS,
            r"/api/v1/analytics/overview": {
                "totals": {"total": 100, "successful": 90, "failed": 8, "pending": 1, "uncertain": 1, "cancelled": 0},
                "successRate": 0.9184,
                "volume": [],
                "latency": {},
            },
            r"/api/v1/analytics/timeseries": {
                "metric": "PROCESSOR_LATENCY_P95",
                "points": [{"bucketStart": "2026-10-15T11:00:00Z", "value": 950, "sampleSize": 30}],
            },
            r"/api/v1/reconciliations/discrepancies": fakes.page([]),
            r"/api/v1/anomalies": fakes.page([]),
        },
        **kw,
    )


def agent(mode="normal", provider=None):
    return AnalyticsAgent(provider or MockProvider(mode), Settings(provider="mock"), now=lambda: NOW)  # type: ignore[arg-type]


def test_processor_failure_rate_question_uses_real_numbers_and_returns_metadata():
    b = backend()
    r = agent().run("Which processor has the highest failure rate today?", b)
    assert r.status == "COMPLETED" and r.explanationSource == "llm" and r.plannerSource == "llm"
    assert "MOCK_PROCESSOR_EU" in r.explanation and "22.2%" in r.explanation
    assert r.results["op1"]["data"] == PROCESSORS, "numbers come from the query result, untouched"
    assert r.operations[0]["name"] == "processor_stats" and r.operations[0]["endpoint"] == "/api/v1/analytics/processors"
    assert (
        r.metricsUsed and r.timeRange == {"from": "2026-10-15T00:00:00Z", "to": "2026-10-15T12:00:00Z"} and r.dashboardLink.startswith("/")
    )
    assert b.calls[0][1]["from"] == "2026-10-15T00:00:00Z"


def test_failure_increase_question_combines_trends_reasons_and_processors():
    r = agent().run("Why did payment failures increase in the last hour?", backend())
    assert [o["name"] for o in r.operations] == ["payment_trends", "failure_reasons", "processor_stats"]
    assert r.timeRange == {"from": "2026-10-15T11:00:00Z", "to": "2026-10-15T12:00:00Z"}
    assert r.status == "COMPLETED"


@pytest.mark.parametrize(
    ("question", "operation"),
    [
        ("What are the most common causes of failed payments?", "failure_reasons"),
        ("Are any services showing unusual latency?", "processor_stats"),
        ("Which reconciliation discrepancies require investigation?", "open_discrepancies"),
        ("Any anomalies in the last 6 hours?", "recent_anomalies"),
        ("Give me an overview of payment volume", "overview"),
    ],
)
def test_the_five_documented_question_types_map_to_predefined_operations(question, operation):
    r = agent().run(question, backend())
    assert r.operations[0]["name"] == operation and r.status in {"COMPLETED", "DEGRADED"} and r.results


def test_unsupported_questions_are_refused_without_running_anything():
    b = backend()
    r = agent().run("What is the weather in Berlin?", b)
    assert r.status == "UNSUPPORTED" and not b.calls and r.supportedOperations
    r2 = agent().run("DROP TABLE payments; SELECT * FROM users", b)
    assert r2.status == "UNSUPPORTED" and not b.calls


class Scripted:
    name, model = "scripted", "s"

    def __init__(self, plan, explanation=None):
        self.plan, self.explanation, self.calls = plan, explanation, []

    def configured(self):
        return True

    def complete(self, request):
        import json

        from app.providers import LLMResponse, TaskType

        self.calls.append(request)
        body = self.plan if request.task is TaskType.ANALYTICS_PLAN else (self.explanation or {"explanation": "ok", "highlights": []})
        return LLMResponse(json.dumps(body), "scripted", "s", 1, 1)


@pytest.mark.parametrize(
    "plan",
    [
        {"operations": [{"name": "run_sql", "args": {"query": "SELECT * FROM payments"}}]},  # unknown operation
        {"operations": [{"name": "failure_reasons", "args": {"limit": 5000}}]},  # out-of-range argument
        {"operations": [{"name": "failure_reasons", "args": {"window": "last_10_years"}}]},  # window outside the enum
        {"operations": [{"name": "processor_stats", "args": {"window": "today", "sql": "1=1"}}]},  # extra argument
        {
            "operations": [{"name": "timeseries", "args": {"metric": "FAILURE_RATE", "processor": "x'; DROP TABLE payments;--"}}]
        },  # injection in a string argument
        {"operations": [{"name": "timeseries", "args": {"window": "today"}}]},  # missing required argument
    ],
)
def test_invalid_model_plans_never_reach_the_backend_and_fall_back_to_rules(plan):
    b = backend()
    provider = Scripted(plan)
    r = agent(provider=provider).run("Which processor has the highest failure rate today?", b)
    assert r.plannerSource == "rules" and r.errorCategory and "rejected" in r.notice
    assert [c[0] for c in b.calls] == ["/api/v1/analytics/processors"], "only the rule planner's allow-listed query ran"
    assert not any("sql" in str(c[1]).lower() or "drop" in str(c[1]).lower() for c in b.calls)


def test_plan_validation_unit():
    with pytest.raises(PlanError):
        validate_plan(AnalyticsPlan.model_validate({"operations": [{"name": "delete_everything", "args": {}}]}))
    ok = validate_plan(
        AnalyticsPlan.model_validate({"operations": [{"name": "failure_reasons", "args": {"window": "last_hour", "limit": 3}}]})
    )
    assert ok[0][1].limit == 3
    assert set(OPERATIONS) == {
        "overview",
        "processor_stats",
        "failure_reasons",
        "payment_trends",
        "timeseries",
        "open_discrepancies",
        "recent_anomalies",
    }


def test_time_windows_are_resolved_by_code_and_bounded():
    assert resolve_window("last_hour", NOW)[0] == datetime(2026, 10, 15, 11, 0, tzinfo=UTC)
    assert resolve_window("today", NOW)[0] == datetime(2026, 10, 15, 0, 0, tzinfo=UTC)
    early = datetime(2026, 10, 15, 0, 20, tzinfo=UTC)
    assert (early - resolve_window("today", early)[0]).total_seconds() == 3600, "'today' just after midnight still covers at least an hour"
    assert (NOW - resolve_window("last_30_days", NOW)[0]).days == 30  # inside the backend's 31 day cap


def test_explanation_with_invented_numbers_is_replaced_by_a_template():
    r = agent("fabricate").run("Which processor has the highest failure rate today?", backend())
    assert r.explanationSource == "template" and r.status == "DEGRADED" and r.errorCategory == "UNGROUNDED_NUMBERS"
    assert "99.9" not in r.explanation and "22.2%" in r.explanation
    assert r.validation.errors


def test_percentages_derived_from_ratios_and_counts_are_accepted():
    ok = {"explanation": "MOCK_PROCESSOR_EU fails 22.2% of 180 attempts (8 timeouts); MOCK_PROCESSOR 5% of 200.", "highlights": []}
    r = agent(provider=Scripted({"operations": [{"name": "processor_stats", "args": {"window": "today"}}]}, ok)).run(
        "Which processor has the highest failure rate today?", backend()
    )
    assert r.explanationSource == "llm" and r.status == "COMPLETED"


def test_llm_outage_degrades_to_rule_planner_and_template_with_real_numbers():
    for mode in ("timeout", "rate_limited", "unavailable"):
        r = agent(mode).run("Which processor has the highest failure rate today?", backend())
        assert (
            r.status == "DEGRADED"
            and r.plannerSource == "rules"
            and r.explanationSource == "template"
            and r.errorCategory.startswith("PROVIDER_")
        )
        assert "22.2%" in r.explanation and "unavailable" in r.notice


def test_access_denied_is_reported_per_operation():
    r = agent().run("Why did payment failures increase in the last hour?", backend(deny=("/api/v1/analytics/failure-reasons",)))
    assert any("failure_reasons" in g and "access denied" in g for g in r.gaps)
    assert {o["name"] for o in r.operations} == {"payment_trends", "processor_stats"}
    r2 = agent().run("Which reconciliation discrepancies require investigation?", backend(deny=("/api/v1/reconciliations",)))
    assert not r2.results and r2.explanation is None and "permissions" in r2.notice


def test_rule_planner_handles_windows_and_processors():
    plan = rules_plan("latency for MOCK_PROCESSOR_EU in the last 7 days")
    assert plan["operations"][1]["args"] == {"window": "last_7_days", "metric": "PROCESSOR_LATENCY_P95", "processor": "MOCK_PROCESSOR_EU"}
