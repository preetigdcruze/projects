"""Natural-language analytics over a *closed* set of predefined, parameterised operations.

The model (or the keyword planner) chooses operation names and arguments; this module validates every argument against a
schema, resolves time windows itself, enforces limits, and executes only allow-listed read-only backend endpoints with the
caller's own token. All numbers in the response come from those queries; the model only explains them."""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .backend_client import BackendError, BackendReader
from .config import Settings
from .models import AnalyticsPlan, AnalyticsResponse, Highlight, ModelExplanation, Usage, ValidationReport
from .output_validation import OutputRejected, numbers_in, parse_model, ungrounded_numbers
from .planner_rules import rules_plan
from .prompts import SYSTEM_EXPLAIN, SYSTEM_PLAN, explain_user_message, plan_user_message
from .providers import LLMMessage, LLMProvider, LLMRequest, ProviderError, TaskType
from .templates import template_explanation

log = logging.getLogger("paysense.ai.analytics")

Window = Literal["last_hour", "last_6_hours", "today", "last_24_hours", "last_7_days", "last_30_days"]
_PROCESSOR_PATTERN = r"^[A-Z0-9_]{1,32}$"


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WindowArgs(_Args):
    window: Window = "last_24_hours"


class FailureReasonsArgs(WindowArgs):
    limit: int = Field(default=10, ge=1, le=20)


class TrendsArgs(WindowArgs):
    bucket: Literal["MINUTE_15", "HOUR", "DAY"] | None = None


class TimeseriesArgs(WindowArgs):
    metric: Literal["FAILURE_RATE", "TIMEOUT_RATE", "PROCESSOR_LATENCY_P95", "THROUGHPUT", "DISCREPANCY_COUNT"]
    bucket: Literal["MINUTE_15", "HOUR", "DAY"] | None = None
    processor: str | None = Field(default=None, pattern=_PROCESSOR_PATTERN)


class DiscrepancyArgs(_Args):
    status: Literal["OPEN", "ACKNOWLEDGED"] = "OPEN"
    type: (
        Literal[
            "MISSING_FROM_REPORT", "MISSING_INTERNALLY", "AMOUNT_MISMATCH", "CURRENCY_MISMATCH", "DUPLICATE_SETTLEMENT", "UNEXPECTED_STATE"
        ]
        | None
    ) = None


class AnomalyArgs(WindowArgs):
    metric: Literal["FAILURE_RATE", "TIMEOUT_RATE", "PROCESSOR_LATENCY_P95", "THROUGHPUT", "DISCREPANCY_COUNT"] | None = None
    processor: str | None = Field(default=None, pattern=_PROCESSOR_PATTERN)


@dataclass(frozen=True)
class Operation:
    name: str
    description: str
    args: type[_Args]
    path: str
    metrics: list[str]
    build: Callable[[Any, datetime, datetime], dict[str, Any]]
    link: str
    trim: Callable[[Any], Any] = lambda d: d


def _iso(d: datetime) -> str:
    return d.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _auto_bucket(hours: float) -> str:
    return "MINUTE_15" if hours <= 6 else "HOUR" if hours <= 72 else "DAY"


def _trim_points(data: Any) -> Any:
    if isinstance(data, dict) and "points" in data:
        return {**data, "points": data["points"][-200:]}
    if isinstance(data, list):
        return data[-200:]
    return data


OPERATIONS: dict[str, Operation] = {
    op.name: op
    for op in [
        Operation(
            "overview",
            "Totals by status, success rate, volume per currency and latency percentiles.",
            WindowArgs,
            "/api/v1/analytics/overview",
            ["payments.total", "payments.success_rate", "processor.latency_percentiles"],
            lambda a, f, t: {"from": _iso(f), "to": _iso(t)},
            "/",
        ),
        Operation(
            "processor_stats",
            "Per-processor attempts, failure rate, timeout rate and latency percentiles.",
            WindowArgs,
            "/api/v1/analytics/processors",
            ["processor.failure_rate", "processor.timeout_rate", "processor.latency_percentiles"],
            lambda a, f, t: {"from": _iso(f), "to": _iso(t)},
            "/",
        ),
        Operation(
            "failure_reasons",
            "Most common reasons processor attempts did not succeed.",
            FailureReasonsArgs,
            "/api/v1/analytics/failure-reasons",
            ["attempts.failure_reason_counts"],
            lambda a, f, t: {"from": _iso(f), "to": _iso(t), "limit": a.limit},
            "/",
        ),
        Operation(
            "payment_trends",
            "Payments over time by status with failure rate per bucket.",
            TrendsArgs,
            "/api/v1/analytics/payment-trends",
            ["payments.failure_rate_over_time"],
            lambda a, f, t: {"from": _iso(f), "to": _iso(t), "bucket": a.bucket or _auto_bucket((t - f).total_seconds() / 3600)},
            "/",
            _trim_points,
        ),
        Operation(
            "timeseries",
            "One bucketed metric (failure rate, timeout rate, p95 latency, throughput, discrepancy count), optionally per processor.",
            TimeseriesArgs,
            "/api/v1/analytics/timeseries",
            ["timeseries"],
            lambda a, f, t: {
                "metric": a.metric,
                "from": _iso(f),
                "to": _iso(t),
                "processor": a.processor,
                "bucket": a.bucket or _auto_bucket((t - f).total_seconds() / 3600),
            },
            "/",
            _trim_points,
        ),
        Operation(
            "open_discrepancies",
            "Reconciliation discrepancies by status/type.",
            DiscrepancyArgs,
            "/api/v1/reconciliations/discrepancies",
            ["reconciliation.discrepancies"],
            lambda a, f, t: {"status": a.status, "type": a.type, "size": 25},
            "/reconciliation",
        ),
        Operation(
            "recent_anomalies",
            "Statistically detected anomalies.",
            AnomalyArgs,
            "/api/v1/anomalies",
            ["anomalies"],
            lambda a, f, t: {"since": _iso(f), "metric": a.metric, "dimension": a.processor, "size": 25},
            "/incidents",
        ),
    ]
}


def resolve_window(window: str, now: datetime) -> tuple[datetime, datetime]:
    """Time windows are resolved here, not by the model: bounded, UTC, never longer than 30 days."""
    to = now
    if window == "last_hour":
        return to - timedelta(hours=1), to
    if window == "last_6_hours":
        return to - timedelta(hours=6), to
    if window == "today":
        start = to.replace(hour=0, minute=0, second=0, microsecond=0)
        return (start if to - start >= timedelta(hours=1) else to - timedelta(hours=1)), to
    if window == "last_7_days":
        return to - timedelta(days=7), to
    if window == "last_30_days":
        return to - timedelta(days=30), to
    return to - timedelta(hours=24), to


def catalog() -> list[dict[str, Any]]:
    return [
        {"name": o.name, "description": o.description, "args_schema": o.args.model_json_schema()["properties"]} for o in OPERATIONS.values()
    ]


class PlanError(Exception):
    pass


def validate_plan(plan: AnalyticsPlan) -> list[tuple[Operation, _Args]]:
    out = []
    for call in plan.operations:
        op = OPERATIONS.get(call.name)
        if op is None:
            raise PlanError(f"unknown operation '{call.name}'")
        try:
            out.append((op, op.args.model_validate(call.args)))
        except ValidationError as e:
            raise PlanError(f"invalid arguments for '{call.name}': {e.errors()[0]['msg']}") from e
    return out


class AnalyticsAgent:
    def __init__(self, provider: LLMProvider, settings: Settings, now: Callable[[], datetime] = lambda: datetime.now(UTC)):
        self.provider, self.settings, self._now = provider, settings, now

    def run(self, question: str, reader: BackendReader) -> AnalyticsResponse:
        now = self._now()
        report = ValidationReport()
        usage = Usage()
        gaps: list[str] = []
        notice: str | None = None
        error_category: str | None = None
        planner_source: Literal["llm", "rules", "none"] = "llm"
        llm_available = True

        # ---- plan -------------------------------------------------------------------------------------------------
        plan: AnalyticsPlan | None = None
        validated: list[tuple[Operation, _Args]] = []
        provider_name = provider_model = None
        try:
            resp = self.provider.complete(
                LLMRequest(TaskType.ANALYTICS_PLAN, SYSTEM_PLAN, [LLMMessage("user", plan_user_message(question, catalog()))], 400)
            )
            provider_name, provider_model = resp.provider, resp.model
            usage = Usage(promptTokens=resp.prompt_tokens, completionTokens=resp.completion_tokens)
            plan = parse_model(resp.text, AnalyticsPlan, report)
            validated = validate_plan(plan)
        except ProviderError as e:
            llm_available, error_category = False, e.category
            notice = (
                f"The AI provider is unavailable ({e.category}); the question was mapped with keyword rules and explained with a template."
            )
        except (OutputRejected, PlanError) as e:
            error_category = getattr(e, "category", "INVALID_PLAN")
            report.errors.append(str(e) if isinstance(e, PlanError) else "plan rejected")
            notice = "The model's plan was rejected by validation; the question was mapped with keyword rules instead."
            plan = None
            validated = []
        if plan is None or (not validated and llm_available is False):
            planner_source = "rules"
            try:
                plan = AnalyticsPlan.model_validate(rules_plan(question))
                validated = validate_plan(plan)
            except (PlanError, ValidationError) as e:  # rule planner output is ours; failing here is a bug worth surfacing
                report.errors.append(str(e))
                plan, validated = AnalyticsPlan(), []
        elif not validated:
            planner_source = "llm"

        if not validated:
            return AnalyticsResponse(
                status="UNSUPPORTED",
                question=question,
                explanation=None,
                explanationSource="none",
                operations=[],
                metricsUsed=[],
                timeRange=None,
                results={},
                supportedOperations=sorted(OPERATIONS),
                plannerSource="none" if not llm_available else planner_source,
                validation=report,
                provider=provider_name or self.provider.name,
                model=provider_model or self.provider.model,
                usage=usage,
                errorCategory=error_category,
                notice=notice
                or "No supported analytics operation matches this question. Try asking about failure rates, failure reasons, processors, latency, discrepancies or anomalies.",
                generatedAt=now,
            )

        # ---- execute (read-only, caller-authorised) -----------------------------------------------------------------
        results: dict[str, Any] = {}
        ops_meta: list[dict[str, Any]] = []
        windows: list[tuple[datetime, datetime]] = []
        metrics_used: list[str] = []
        link = "/"
        for i, (op, args) in enumerate(validated, start=1):
            opid = f"op{i}"
            window_name = getattr(args, "window", "last_24_hours")
            f, t = resolve_window(window_name, now)
            windows.append((f, t))
            try:
                data = reader_get(reader, op, args, f, t)
            except BackendError as e:
                gaps.append(
                    f"{op.name}: {'access denied for your role' if e.kind == 'denied' else 'could not be retrieved (' + e.kind + ')'}"
                )
                continue
            results[opid] = {
                "name": op.name,
                "args": args.model_dump(exclude_none=True),
                "timeRange": {"from": _iso(f), "to": _iso(t)},
                "data": op.trim(data),
            }
            ops_meta.append(
                {
                    "id": opid,
                    "name": op.name,
                    "args": args.model_dump(exclude_none=True),
                    "endpoint": op.path,
                    "timeRange": {"from": _iso(f), "to": _iso(t)},
                }
            )
            metrics_used += [m for m in op.metrics if m not in metrics_used]
            link = op.link
        time_range = {"from": _iso(min(w[0] for w in windows)), "to": _iso(max(w[1] for w in windows))} if windows else None
        dashboard = f"{link}?from={time_range['from']}&to={time_range['to']}" if time_range and link in {"/"} else link

        # ---- explain ------------------------------------------------------------------------------------------------
        explanation, source, highlights = template_explanation(results), "template", []
        status: Literal["COMPLETED", "DEGRADED", "UNSUPPORTED"] = "DEGRADED"
        if results and llm_available:
            try:
                resp = self.provider.complete(
                    LLMRequest(
                        TaskType.ANALYTICS_EXPLAIN,
                        SYSTEM_EXPLAIN,
                        [LLMMessage("user", explain_user_message(question, results))],
                        self.settings.max_output_tokens,
                    )
                )
                usage = Usage(
                    promptTokens=(usage.promptTokens or 0) + (resp.prompt_tokens or 0),
                    completionTokens=(usage.completionTokens or 0) + (resp.completion_tokens or 0),
                )
                parsed = parse_model(resp.text, ModelExplanation, report)
                bad = ungrounded_numbers(parsed.explanation + " " + " ".join(h.text for h in parsed.highlights), numbers_in(results))
                if bad:
                    report.errors.append(f"explanation contains numbers that are not in the query results: {bad[:5]}")
                    raise OutputRejected("UNGROUNDED_NUMBERS", report.errors)
                explanation, source, highlights, status = parsed.explanation, "llm", parsed.highlights, "COMPLETED"
            except ProviderError as e:
                error_category = e.category
                notice = f"The AI provider is unavailable ({e.category}); the explanation below is a template built from the query results."
            except OutputRejected as e:
                error_category = e.category
                notice = f"The model's explanation was rejected by validation ({e.category}); showing a template explanation built from the query results."
        elif not results:
            explanation, source = None, "none"
            notice = notice or "None of the queries could be completed with your permissions."

        return AnalyticsResponse(
            status=status,
            question=question,
            explanation=explanation,
            explanationSource=source if explanation else "none",
            operations=ops_meta,  # type: ignore[arg-type]
            metricsUsed=metrics_used,
            timeRange=time_range,
            results=results,
            highlights=[Highlight(**h.model_dump()) for h in highlights],
            dashboardLink=dashboard,
            supportedOperations=sorted(OPERATIONS),
            gaps=gaps,
            plannerSource=planner_source,
            validation=report,
            provider=provider_name or self.provider.name,
            model=provider_model or self.provider.model,
            usage=usage,
            errorCategory=error_category,
            notice=notice,
            generatedAt=now,
        )


def reader_get(reader: BackendReader, op: Operation, args: _Args, f: datetime, t: datetime) -> Any:
    return reader.get(op.path, op.build(args, f, t))
