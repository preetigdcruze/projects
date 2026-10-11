"""Pydantic models. Everything the LLM returns is parsed into the strict `Model*` classes (extra fields are errors),
and everything this service returns is described by an explicit response model."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

Level = Literal["low", "medium", "high"]

CONFIDENCE_MEANING = {
    "low": "Little or only indirect evidence supports the explanation; treat it as a lead, not a finding.",
    "medium": "At least one direct piece of evidence supports the explanation, but important alternatives are not ruled out.",
    "high": "Several independent pieces of evidence agree and no retrieved evidence contradicts the explanation. Still an interpretation, not proof.",
}


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# ---- evidence ------------------------------------------------------------------------------------------------------


class Evidence(BaseModel):
    """One retrieved fact. `id` is what the model must cite; ids are created by this service, never by the model."""

    id: str
    kind: Literal[
        "payment", "payment_event", "attempt", "log", "discrepancy", "metric", "anomaly", "incident", "runbook", "processor_stats"
    ]
    summary: str  # deterministic one-liner built from structured fields only (no untrusted text)
    data: dict[str, Any] = Field(default_factory=dict)  # allow-listed structured fields
    untrusted_text: str | None = None  # free text from logs/descriptions/processor messages, cleaned and possibly withheld
    withheld: bool = False
    observed_at: datetime | None = None
    link: str | None = None  # dashboard route for the UI


class Fact(BaseModel):
    id: str
    kind: str
    text: str
    observedAt: datetime | None = None
    link: str | None = None
    untrustedText: str | None = None
    withheld: bool = False


class Usage(BaseModel):
    promptTokens: int | None = None
    completionTokens: int | None = None


# ---- investigation -------------------------------------------------------------------------------------------------


class InvestigationRequest(BaseModel):
    investigationId: UUID | None = None
    subjectType: Literal["PAYMENT", "INCIDENT", "ANOMALY"]
    subjectId: UUID
    question: str = Field(min_length=3, max_length=1000)


class Claim(Strict):
    statement: str = Field(min_length=1, max_length=500)
    evidence_ids: list[str] = Field(min_length=1, max_length=8)


class Hypothesis(Strict):
    statement: str = Field(min_length=1, max_length=500)
    evidence_ids: list[str] = Field(default_factory=list, max_length=8)
    likelihood: Level = "low"


class ModelInvestigation(Strict):
    """The only shape accepted from the model for an investigation."""

    summary: str = Field(min_length=1, max_length=800)
    most_likely_explanation: Hypothesis
    supporting_evidence: list[Claim] = Field(default_factory=list, max_length=10)
    alternative_explanations: list[Hypothesis] = Field(default_factory=list, max_length=5)
    confidence: Level
    confidence_explanation: str = Field(min_length=1, max_length=500)
    recommended_diagnostic_steps: list[str] = Field(default_factory=list, max_length=8)
    missing_information: list[str] = Field(default_factory=list, max_length=8)
    insufficient_evidence: bool = False

    @field_validator("recommended_diagnostic_steps", "missing_information")
    @classmethod
    def _bounded(cls, v: list[str]) -> list[str]:
        if any(len(s) > 400 for s in v):
            raise ValueError("list items must be at most 400 characters")
        return v


class Finding(BaseModel):
    """A deterministic, rule-derived observation (no LLM involved). Always available, even when the LLM is not."""

    text: str
    evidenceIds: list[str]


class ValidationReport(BaseModel):
    rejectedCitations: list[str] = Field(default_factory=list)
    injectionFlags: list[str] = Field(default_factory=list)
    prohibitedActionAttempt: bool = False
    errors: list[str] = Field(default_factory=list)


class RunbookReference(BaseModel):
    source: str  # runbook:<doc_key>@v<version>
    title: str
    docType: str
    snippet: str
    withheld: bool = False


class InvestigationResponse(BaseModel):
    status: Literal["COMPLETED", "DEGRADED"]
    subject: dict[str, str]
    question: str
    # Observed, verifiable data. Rendered as "verified facts" by the UI.
    facts: list[Fact]
    findings: list[Finding]
    # Model interpretation. Rendered as "AI-generated interpretation" by the UI. Null when the LLM was unavailable
    # or its answer failed validation.
    analysis: ModelInvestigation | None = None
    confidenceMeaning: dict[str, str] = CONFIDENCE_MEANING
    # Instructions from runbooks; kept apart from evidence about this incident.
    runbookGuidance: list[RunbookReference] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)  # information we could not retrieve (e.g. access denied)
    validation: ValidationReport = Field(default_factory=ValidationReport)
    provider: str | None = None
    model: str | None = None
    usage: Usage = Field(default_factory=Usage)
    latencyMs: int = 0
    errorCategory: str | None = None
    notice: str | None = None
    generatedAt: datetime


# ---- analytics -----------------------------------------------------------------------------------------------------


class AnalyticsRequest(BaseModel):
    question: str = Field(min_length=3, max_length=500)


class OperationCall(Strict):
    name: str = Field(min_length=1, max_length=64)
    args: dict[str, Any] = Field(default_factory=dict)


class AnalyticsPlan(Strict):
    operations: list[OperationCall] = Field(default_factory=list, max_length=3)
    reason: str | None = Field(default=None, max_length=300)


class Highlight(Strict):
    ref: str = Field(max_length=120)
    text: str = Field(max_length=300)


class ModelExplanation(Strict):
    explanation: str = Field(min_length=1, max_length=1500)
    highlights: list[Highlight] = Field(default_factory=list, max_length=6)


class AnalyticsResponse(BaseModel):
    status: Literal["COMPLETED", "DEGRADED", "UNSUPPORTED"]
    question: str
    explanation: str | None
    explanationSource: Literal["llm", "template", "none"]
    operations: list[dict[str, Any]]  # [{id, name, args, endpoint, timeRange}]
    metricsUsed: list[str]
    timeRange: dict[str, str] | None
    results: dict[str, Any]  # raw numbers, straight from the backend queries
    highlights: list[Highlight] = Field(default_factory=list)
    dashboardLink: str | None = None
    supportedOperations: list[str] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)
    plannerSource: Literal["llm", "rules", "none"] = "none"
    validation: ValidationReport = Field(default_factory=ValidationReport)
    provider: str | None = None
    model: str | None = None
    usage: Usage = Field(default_factory=Usage)
    errorCategory: str | None = None
    notice: str | None = None
    generatedAt: datetime


# ---- incident summary ----------------------------------------------------------------------------------------------


class TimelineItem(Strict):
    text: str = Field(max_length=300)
    evidence_ids: list[str] = Field(default_factory=list, max_length=6)


class Cause(Strict):
    statement: str = Field(max_length=500)
    evidence_ids: list[str] = Field(min_length=1, max_length=8)
    confidence: Level


class MitigationStep(Strict):
    text: str = Field(max_length=400)
    runbook_source: str | None = Field(default=None, max_length=120)


class ModelIncidentNarrative(Strict):
    title: str = Field(min_length=1, max_length=200)
    likely_causes: list[Cause] = Field(default_factory=list, max_length=5)
    key_events: list[TimelineItem] = Field(default_factory=list, max_length=10)
    investigation_steps: list[str] = Field(default_factory=list, max_length=8)
    mitigation_steps: list[MitigationStep] = Field(default_factory=list, max_length=8)
    uncertainties: list[str] = Field(default_factory=list, max_length=8)
    missing_evidence: list[str] = Field(default_factory=list, max_length=8)


class IncidentResponse(BaseModel):
    status: Literal["COMPLETED", "DEGRADED"]
    incidentId: str
    title: str
    timeWindow: dict[str, str | None]
    affectedComponents: list[str]
    failureCounts: dict[str, int]  # computed deterministically from linked records
    impact: dict[str, Any]  # computed deterministically; states its own basis
    facts: list[Fact]
    timeline: list[dict[str, Any]]
    narrative: ModelIncidentNarrative | None = None  # AI interpretation
    runbookGuidance: list[RunbookReference] = Field(default_factory=list)
    remediationClaims: Literal["none-verified"] = "none-verified"
    gaps: list[str] = Field(default_factory=list)
    validation: ValidationReport = Field(default_factory=ValidationReport)
    provider: str | None = None
    model: str | None = None
    usage: Usage = Field(default_factory=Usage)
    errorCategory: str | None = None
    notice: str | None = None
    generatedAt: datetime


# ---- anomaly detection ---------------------------------------------------------------------------------------------


class DetectRequest(BaseModel):
    from_: datetime | None = Field(default=None, alias="from")
    to: datetime | None = None
    bucket: Literal["MINUTE_15", "HOUR"] = "HOUR"
    metrics: list[str] | None = None
    processors: list[str] | None = Field(default=None, max_length=10)
    persist: bool = True
    evaluate_last: int = Field(default=6, ge=1, le=48)

    model_config = ConfigDict(populate_by_name=True)


class RunbookAskRequest(BaseModel):
    question: str = Field(min_length=3, max_length=500)


class ModelRunbookAnswer(Strict):
    answer: str = Field(min_length=1, max_length=1500)
    sources: list[str] = Field(min_length=1, max_length=5)


class RunbookAnswerResponse(BaseModel):
    status: Literal["COMPLETED", "DEGRADED", "NO_MATCH"]
    question: str
    answer: str | None
    answerSource: Literal["llm", "none"]
    guidance: list[RunbookReference]
    notice: str | None = None
    provider: str | None = None
    model: str | None = None
    errorCategory: str | None = None
    generatedAt: datetime
