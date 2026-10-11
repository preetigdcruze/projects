from __future__ import annotations

import re
from datetime import UTC, datetime

from .backend_client import BackendReader
from .config import Settings
from .models import ModelRunbookAnswer, RunbookAnswerResponse, ValidationReport
from .output_validation import OutputRejected, check_claims_of_action, parse_model
from .prompts import SYSTEM_RUNBOOK, runbook_user_message
from .providers import LLMMessage, LLMProvider, LLMRequest, ProviderError, TaskType
from .rag import excerpts_for_prompt, search_runbooks

_STOP = {
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "do",
    "does",
    "did",
    "how",
    "what",
    "why",
    "should",
    "can",
    "i",
    "we",
    "to",
    "of",
    "in",
    "on",
    "for",
    "and",
    "or",
    "when",
    "it",
    "this",
    "that",
    "with",
}


def keywords(question: str) -> str:
    words = [w for w in re.findall(r"[a-zA-Z]{3,}", question.lower()) if w not in _STOP]
    return " ".join(dict.fromkeys(words))[:150]


def ask_runbooks(provider: LLMProvider, settings: Settings, reader: BackendReader, question: str) -> RunbookAnswerResponse:
    refs, gaps = search_runbooks(reader, keywords(question), limit=3)
    now = datetime.now(UTC)
    if not refs:
        return RunbookAnswerResponse(
            status="NO_MATCH",
            question=question,
            answer=None,
            answerSource="none",
            guidance=[],
            generatedAt=now,
            notice="No runbook or past incident report matched. " + " ".join(gaps),
        )
    report = ValidationReport()
    try:
        r = provider.complete(
            LLMRequest(
                TaskType.RUNBOOK_ANSWER,
                SYSTEM_RUNBOOK,
                [LLMMessage("user", runbook_user_message(question, excerpts_for_prompt(refs)))],
                600,
            )
        )
    except ProviderError as e:
        return RunbookAnswerResponse(
            status="DEGRADED",
            question=question,
            answer=None,
            answerSource="none",
            guidance=refs,
            generatedAt=now,
            provider=provider.name,
            model=provider.model,
            errorCategory=e.category,
            notice=f"The AI provider is unavailable ({e.category}). The matching runbook excerpts are shown without a summary.",
        )
    try:
        a = parse_model(r.text, ModelRunbookAnswer, report)
        allowed = {x.source for x in refs if not x.withheld} | {"none"}
        if any(s not in allowed for s in a.sources):
            raise OutputRejected("FABRICATED_RUNBOOK", ["answer cites a runbook that was not retrieved"])
        check_claims_of_action([a.answer], report)
        return RunbookAnswerResponse(
            status="COMPLETED",
            question=question,
            answer=a.answer,
            answerSource="llm",
            guidance=refs,
            generatedAt=now,
            provider=r.provider,
            model=r.model,
        )
    except OutputRejected as e:
        return RunbookAnswerResponse(
            status="DEGRADED",
            question=question,
            answer=None,
            answerSource="none",
            guidance=refs,
            generatedAt=now,
            provider=r.provider,
            model=r.model,
            errorCategory=e.category,
            notice=f"The model's answer was rejected by validation ({e.category}). The matching excerpts are shown instead.",
        )
