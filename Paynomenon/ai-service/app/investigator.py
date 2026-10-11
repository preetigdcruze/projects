"""Payment / incident / anomaly investigation workflow.

retrieve (read-only, caller-authorised) -> clean & budget -> LLM (optional) -> validate -> respond.
The response always contains the retrieved facts and rule-based findings; the model's interpretation is attached only
if it passes validation, and is labelled separately so users can tell observation from interpretation.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import UTC, datetime

from .backend_client import BackendError, BackendReader
from .config import Settings
from .diagnosis import diagnose, runbook_query
from .evidence import Gathered, budget, gather_anomaly, gather_incident, gather_payment
from .models import Evidence, Fact, InvestigationRequest, InvestigationResponse, Usage, ValidationReport
from .output_validation import OutputRejected, validate_investigation
from .prompts import SYSTEM_INVESTIGATION, investigation_user_message
from .providers import LLMMessage, LLMProvider, LLMRequest, ProviderError, TaskType
from .rag import search_runbooks
from .untrusted import clean_untrusted, looks_like_instructions

log = logging.getLogger("paysense.ai.investigator")

GENERIC_QUESTION = "Explain the current state of this subject and the most likely reason for any failure."


def to_facts(evidence: list[Evidence]) -> list[Fact]:
    return [
        Fact(
            id=e.id, kind=e.kind, text=e.summary, observedAt=e.observed_at, link=e.link, untrustedText=e.untrusted_text, withheld=e.withheld
        )
        for e in sorted(evidence, key=lambda e: e.observed_at or datetime.min.replace(tzinfo=UTC))
    ]


class Investigator:
    def __init__(self, provider: LLMProvider, settings: Settings):
        self.provider, self.settings = provider, settings

    def run(self, req: InvestigationRequest, reader: BackendReader) -> InvestigationResponse:
        started = time.monotonic()
        subject_id = str(req.subjectId)
        report = ValidationReport()

        # 1. retrieve (BackendError for the subject itself propagates: unknown id -> 404, no access -> 403)
        if req.subjectType == "PAYMENT":
            gathered = gather_payment(reader, subject_id, self.settings.max_untrusted_chars)
        elif req.subjectType == "ANOMALY":
            gathered = gather_anomaly(reader, subject_id, self.settings.max_untrusted_chars)
        else:
            gathered, _ = gather_incident(reader, subject_id, self.settings.max_untrusted_chars)
        report.injectionFlags = sorted(set(gathered.injection_flags))

        # the operator's question is also scanned; instruction-like questions fall back to a neutral one
        question = req.question
        if looks_like_instructions(question):
            report.injectionFlags.append("question")
            question = GENERIC_QUESTION
        question = clean_untrusted(question, 600).text or GENERIC_QUESTION

        evidence, dropped = budget(gathered, self.settings.max_evidence_items, self.settings.max_context_chars)
        gaps = list(gathered.gaps)
        if dropped:
            gaps.append(f"{dropped} lower-priority evidence item(s) were omitted to respect the prompt size limit.")

        # 2. deterministic analysis (always available)
        diagnosis = diagnose(evidence, req.subjectType, gaps)
        runbooks, rb_gaps = search_runbooks(reader, runbook_query(diagnosis.label))
        gaps += rb_gaps

        response = InvestigationResponse(
            status="DEGRADED",
            subject={"type": req.subjectType, "id": subject_id},
            question=req.question,
            facts=to_facts(evidence),
            findings=diagnosis.findings,
            runbookGuidance=runbooks,
            gaps=gaps,
            validation=report,
            generatedAt=datetime.now(UTC),
        )

        # 3. model interpretation (optional)
        known = {e.id for e in evidence}
        corpus = json.dumps([e.model_dump(mode="json") for e in evidence], default=str).lower()
        message = investigation_user_message(req.subjectType, subject_id, question, evidence, gaps)
        try:
            llm = self.provider.complete(
                LLMRequest(TaskType.INVESTIGATION, SYSTEM_INVESTIGATION, [LLMMessage("user", message)], self.settings.max_output_tokens)
            )
        except ProviderError as e:
            response.errorCategory, response.provider, response.model = e.category, self.provider.name, self.provider.model
            response.notice = f"The AI provider is unavailable ({e.category}). Showing retrieved evidence and rule-based findings only; no AI interpretation was generated."
            response.latencyMs = int((time.monotonic() - started) * 1000)
            return response

        response.provider, response.model = llm.provider, llm.model
        response.usage = Usage(promptTokens=llm.prompt_tokens, completionTokens=llm.completion_tokens)
        try:
            response.analysis = validate_investigation(llm.text, known, corpus, report)
            response.status = "COMPLETED"
        except OutputRejected as e:
            response.errorCategory = e.category
            response.notice = f"The model's answer was rejected by validation ({e.category}) and is not shown. Evidence and rule-based findings are still available."
            log.warning("investigation output rejected: %s", e.category)
        response.latencyMs = int((time.monotonic() - started) * 1000)
        return response


__all__ = ["Investigator", "BackendError", "Gathered"]
