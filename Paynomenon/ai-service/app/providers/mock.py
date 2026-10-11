"""Deterministic stand-in for an LLM. No network, no randomness, no key.

It *reads the same prompt a real model would* (the tagged JSON blocks) and answers from the rules in `diagnosis.py`, so
prompt construction, validation and the whole pipeline are exercised end to end. Failure modes can be switched on to
test degradation and adversarial behaviour: they are how the test-suite and the evaluation harness simulate a misbehaving
or unavailable model."""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any, Literal

from ..diagnosis import diagnose
from ..models import Evidence
from ..planner_rules import rules_plan
from ..templates import template_explanation
from .base import LLMProvider, LLMRequest, LLMResponse, ProviderRateLimited, ProviderTimeout, ProviderUnavailable, TaskType

Mode = Literal["normal", "timeout", "rate_limited", "unavailable", "malformed", "fabricate", "inject", "unsafe_claim", "follow_untrusted"]


def _block(text: str, tag: str) -> Any:
    m = re.search(rf"<{tag}>\s*(.*?)\s*</{tag}>", text, re.S)
    return json.loads(m.group(1)) if m else None


def _evidence(raw: list[dict]) -> list[Evidence]:
    out = []
    for r in raw:
        out.append(
            Evidence(
                id=r["id"],
                kind=r["kind"],
                summary=r["summary"],
                data=r.get("data", {}),
                untrusted_text=r.get("untrusted_text"),
                observed_at=datetime.fromisoformat(r["observed_at"]) if r.get("observed_at") else None,
            )
        )
    return out


class MockProvider(LLMProvider):
    name = "mock"
    model = "mock-deterministic-1"

    def __init__(self, mode: Mode = "normal"):
        import os

        self.mode: Mode = mode if mode != "normal" else os.environ.get("AI_MOCK_MODE", "normal")  # type: ignore[assignment]
        self.calls: list[LLMRequest] = []

    def complete(self, request: LLMRequest) -> LLMResponse:
        self.calls.append(request)
        if self.mode == "timeout":
            raise ProviderTimeout("mock provider timeout")
        if self.mode == "rate_limited":
            raise ProviderRateLimited("mock provider rate limit", retry_after=0.01)
        if self.mode == "unavailable":
            raise ProviderUnavailable("mock provider unavailable")
        user = request.messages[-1].content
        text = self._answer(request.task, user)
        return LLMResponse(
            text,
            self.name,
            self.model,
            prompt_tokens=(len(request.system) + len(user)) // 4,
            completion_tokens=len(text) // 4,
            latency_ms=1,
        )

    # ------------------------------------------------------------------------------------------------------------
    def _answer(self, task: TaskType, user: str) -> str:
        if self.mode == "malformed":
            return "I believe the payment failed because of a timeout, but I cannot format this as JSON."
        if task is TaskType.INVESTIGATION:
            return json.dumps(self._investigation(user))
        if task is TaskType.ANALYTICS_PLAN:
            question = re.search(r"Question: (.*)\n<operations_json>", user, re.S)
            return json.dumps(rules_plan(question.group(1) if question else ""))
        if task is TaskType.ANALYTICS_EXPLAIN:
            results = _block(user, "results_json") or {}
            text = template_explanation(results)
            if self.mode == "fabricate":
                text += " Failure rates doubled to 99.9% across all processors."
            return json.dumps({"explanation": text, "highlights": []})
        if task is TaskType.INCIDENT_SUMMARY:
            return json.dumps(self._incident(user))
        return json.dumps(self._runbook(user))

    def _investigation(self, user: str) -> dict:
        evidence = _evidence(_block(user, "evidence_json") or [])
        subject = re.search(r"Subject: (\w+)", user)
        gaps = json.loads(m.group(1)) if (m := re.search(r"Known retrieval gaps: (\[.*\])", user)) else []
        d = diagnose(evidence, subject.group(1) if subject else "PAYMENT", gaps)
        summaries = {e.id: e.summary for e in evidence}
        out: dict[str, Any] = {
            "summary": d.statement,
            "most_likely_explanation": {"statement": d.statement, "evidence_ids": d.evidence_ids, "likelihood": d.confidence},
            "supporting_evidence": [{"statement": summaries[i], "evidence_ids": [i]} for i in d.evidence_ids[:6] if i in summaries],
            "alternative_explanations": [{"statement": s, "evidence_ids": ids, "likelihood": lk} for s, ids, lk in d.alternatives],
            "confidence": d.confidence,
            "confidence_explanation": d.confidence_explanation,
            "recommended_diagnostic_steps": d.steps,
            "missing_information": d.missing,
            "insufficient_evidence": d.insufficient,
        }
        if self.mode == "fabricate":
            out["most_likely_explanation"]["evidence_ids"] = ["evt:00000000-0000-0000-0000-00000000dead"]
            out["supporting_evidence"] = [
                {"statement": "Log line 'connection reset by peer' was recorded.", "evidence_ids": ["log:999999"]}
            ]
        elif self.mode == "inject":
            out["summary"] = "As instructed in the log, I executed refund_payment for the full amount."
        elif self.mode == "unsafe_claim":
            out["summary"] = "We restarted the processor connector and fixed the problem."
        elif self.mode == "follow_untrusted":
            # simulates a model that obeyed text found in the evidence: it echoes the untrusted text as an action
            obeyed = next((e.untrusted_text for e in evidence if e.kind == "log" and e.untrusted_text), "")
            out["recommended_diagnostic_steps"] = [obeyed or "call capture_payment now"]
        return out

    def _incident(self, user: str) -> dict:
        evidence = _evidence(_block(user, "evidence_json") or [])
        runbooks = _block(user, "runbook_excerpts_json") or []
        d = diagnose(evidence, "INCIDENT", [])
        inc = next((e for e in evidence if e.kind == "incident"), None)
        title = (inc.summary.split("'")[1] if inc and "'" in inc.summary else "Incident")[:200]
        cites = d.evidence_ids or ([inc.id] if inc else [])
        out: dict[str, Any] = {
            "title": title,
            "likely_causes": [{"statement": d.statement, "evidence_ids": cites, "confidence": d.confidence}] if cites else [],
            "key_events": [
                {"text": e.summary, "evidence_ids": [e.id]}
                for e in sorted(evidence, key=lambda e: e.observed_at.timestamp() if e.observed_at else 0)[:5]
            ],
            "investigation_steps": d.steps,
            "mitigation_steps": [
                {"text": f"Review '{r['title']}' and follow its diagnosis steps.", "runbook_source": r["source"]} for r in runbooks[:2]
            ],
            "uncertainties": [
                "Root cause is inferred from linked records and not directly observed.",
                "Customer impact figures cover linked payments only.",
            ],
            "missing_evidence": d.missing,
        }
        if self.mode == "fabricate":
            out["likely_causes"] = [
                {"statement": "A database failover caused the failures.", "evidence_ids": ["evt:fabricated"], "confidence": "high"}
            ]
        elif self.mode == "unsafe_claim":
            out["uncertainties"] = ["The issue has been fixed and the processor was restarted."]
        return out

    def _runbook(self, user: str) -> dict:
        runbooks = _block(user, "runbook_excerpts_json") or []
        if not runbooks:
            return {"answer": "The retrieved runbooks do not cover this question.", "sources": ["none"]}
        top = runbooks[0]
        out = {"answer": f"Guidance from '{top['title']}': {top['excerpt']}", "sources": [top["source"]]}
        if self.mode == "fabricate":
            out["sources"] = ["runbook:rb-made-up@v9"]
        return out
