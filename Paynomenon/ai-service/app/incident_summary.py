"""Incident summarisation: deterministic facts and figures + a validated model narrative."""

from __future__ import annotations

import json
import logging
from collections import Counter, defaultdict
from datetime import UTC, datetime
from decimal import Decimal

from .backend_client import BackendReader
from .config import Settings
from .evidence import budget, gather_incident
from .investigator import to_facts
from .models import IncidentResponse, ModelIncidentNarrative, Usage, ValidationReport
from .output_validation import OutputRejected, check_citations, check_claims_of_action, check_grounding, parse_model
from .prompts import SYSTEM_INCIDENT, incident_user_message
from .providers import LLMMessage, LLMProvider, LLMRequest, ProviderError, TaskType
from .rag import excerpts_for_prompt, search_runbooks

log = logging.getLogger("paysense.ai.incident")


def _money(currency: str, value: Decimal) -> str:
    exp = Decimal(1) if currency == "JPY" else Decimal("0.01")
    return format(value.quantize(exp), "f")


def compute_figures(detail: dict) -> tuple[dict[str, int], dict]:
    """Counts and impact come from the linked records, never from the model."""
    payments = detail.get("payments", [])
    by_status = Counter(p["status"] for p in payments)
    by_code = Counter(p.get("failureCode") or "none" for p in payments if p["status"] in {"FAILED", "UNCERTAIN"})
    counts = {
        "linkedPayments": len(payments),
        "failedPayments": by_status.get("FAILED", 0),
        "uncertainPayments": by_status.get("UNCERTAIN", 0),
        "anomalies": len(detail.get("anomalies", [])),
        "discrepancies": len(detail.get("discrepancies", [])),
        "deadLetters": len(detail.get("deadLetterIds", [])),
    }
    amounts: dict[str, Decimal] = defaultdict(Decimal)
    for p in payments:
        if p["status"] in {"FAILED", "UNCERTAIN"}:
            amounts[p["currency"]] += Decimal(str(p["amount"]))
    impact = {
        "paymentsAffected": counts["failedPayments"] + counts["uncertainPayments"],
        "amountAtRiskByCurrency": {c: _money(c, v) for c, v in sorted(amounts.items())},
        "failureCodes": dict(by_code),
        "basis": f"Computed only from the {len(payments)} payment(s) linked to this incident (at most 100 are returned). It is a lower bound, not a measurement of total customer impact.",
    }
    return counts, impact


class IncidentSummarizer:
    def __init__(self, provider: LLMProvider, settings: Settings):
        self.provider, self.settings = provider, settings

    def run(self, incident_id: str, reader: BackendReader) -> IncidentResponse:
        gathered, detail = gather_incident(reader, incident_id, self.settings.max_untrusted_chars)
        inc = detail["incident"]
        report = ValidationReport(injectionFlags=sorted(set(gathered.injection_flags)))
        evidence, dropped = budget(gathered, self.settings.max_evidence_items, self.settings.max_context_chars)
        gaps = list(gathered.gaps) + ([f"{dropped} lower-priority evidence item(s) omitted for size."] if dropped else [])
        counts, impact = compute_figures(detail)
        components = inc.get("components", [])
        query = " ".join(sorted({a["metric"].lower().replace("_", " ") for a in detail.get("anomalies", [])})) or (
            "reconciliation mismatch" if detail.get("discrepancies") else "declines failure rate"
        )
        runbooks, rb_gaps = search_runbooks(reader, query, limit=3)
        gaps += rb_gaps
        timeline = [
            {
                "at": t["at"],
                "kind": t["kind"],
                "refId": t.get("refId"),
                "title": t["title"],
                "detail": (t.get("detail") or "")[:200] if t["kind"] != "LOG" else None,
                "paymentId": t.get("paymentId"),
            }
            for t in detail.get("timeline", [])
        ][:80]

        response = IncidentResponse(
            status="DEGRADED",
            incidentId=incident_id,
            title=inc["title"],
            timeWindow={"start": inc["startedAt"], "end": inc.get("resolvedAt")},
            affectedComponents=components,
            failureCounts=counts,
            impact=impact,
            facts=to_facts(evidence),
            timeline=timeline,
            runbookGuidance=runbooks,
            gaps=gaps,
            validation=report,
            generatedAt=datetime.now(UTC),
        )
        known = {e.id for e in evidence}
        corpus = (
            json.dumps([e.model_dump(mode="json") for e in evidence], default=str).lower() + json.dumps(impact).lower() + json.dumps(counts)
        )
        allowed_sources = {r.source for r in runbooks if not r.withheld}
        try:
            llm = self.provider.complete(
                LLMRequest(
                    TaskType.INCIDENT_SUMMARY,
                    SYSTEM_INCIDENT,
                    [
                        LLMMessage(
                            "user",
                            incident_user_message(
                                incident_id, evidence, excerpts_for_prompt(runbooks), {"counts": counts, "impact": impact}
                            ),
                        )
                    ],
                    self.settings.max_output_tokens,
                )
            )
        except ProviderError as e:
            response.errorCategory, response.provider, response.model = e.category, self.provider.name, self.provider.model
            response.notice = (
                f"The AI provider is unavailable ({e.category}). Figures, timeline and evidence are shown; no AI narrative was generated."
            )
            return response
        response.provider, response.model = llm.provider, llm.model
        response.usage = Usage(promptTokens=llm.prompt_tokens, completionTokens=llm.completion_tokens)
        try:
            n = parse_model(llm.text, ModelIncidentNarrative, report)
            cited = [i for c in n.likely_causes for i in c.evidence_ids] + [i for e in n.key_events for i in e.evidence_ids]
            check_citations(cited, known, report)
            texts = [
                n.title,
                *(c.statement for c in n.likely_causes),
                *(e.text for e in n.key_events),
                *n.investigation_steps,
                *(m.text for m in n.mitigation_steps),
                *n.uncertainties,
                *n.missing_evidence,
            ]
            check_claims_of_action(texts, report)
            check_grounding(texts, corpus, report)
            for m in n.mitigation_steps:
                if m.runbook_source and m.runbook_source not in allowed_sources:
                    report.rejectedCitations.append(m.runbook_source)
                    report.errors.append("mitigation step cites a runbook that was not retrieved")
                    raise OutputRejected("FABRICATED_RUNBOOK", report.errors)
            response.narrative, response.status = n, "COMPLETED"
        except OutputRejected as e:
            response.errorCategory = e.category
            response.notice = f"The model's narrative was rejected by validation ({e.category}) and is not shown."
        return response
