"""Handling of untrusted text (log lines, descriptions, processor messages, runbook text).

Everything that originates outside this code base is treated as hostile data: it is normalised, bounded, scanned for
instruction-like content and, if suspicious, withheld from the model entirely. Whatever is passed on is wrapped as
data in a structured field so the system prompt can reference it as "never instructions".
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from .redaction import redact

_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩﻿]")
_DELIMITERS = re.compile(r"</?\s*(evidence_json|system|assistant|user|tool|instructions?|im_start|im_end)[^>]*>|```|<\|[^|]*\|>", re.I)

# Phrases that address the model or try to change its behaviour. Matching text is withheld, not merely flagged.
_INJECTION = [
    r"ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)",
    r"disregard\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|system)",
    r"(system|developer)\s+prompt",
    r"you\s+are\s+now\b",
    r"\bnew\s+instructions?\b",
    r"\b(act|behave|respond)\s+as\b",
    r"\bjailbreak\b",
    r"\b(call|invoke|run|execute|use)\s+(the\s+)?(tool|function|command|sql|shell|script)\b",
    r"\b(refund|capture|authori[sz]e|cancel|void)_?(payment|charge|transaction)\b",
    r"\bdrop\s+table\b|\bdelete\s+from\b|\btruncate\s+table\b|;\s*--",
    r"\brm\s+-rf\b|\bcurl\s+https?://|\bwget\s+https?://",
    r"\b(reveal|print|show|leak|exfiltrate)\b.{0,40}\b(secret|password|api[_ -]?key|token|credentials?)\b",
    r"\bdo\s+not\s+(tell|mention|reveal)\b",
]
_INJECTION_RE = re.compile("|".join(f"(?:{p})" for p in _INJECTION), re.I | re.S)

WITHHELD = "[content withheld: instruction-like text detected]"


@dataclass(frozen=True)
class CleanText:
    text: str
    withheld: bool
    redacted: bool


def normalise(text: str, max_chars: int) -> str:
    t = unicodedata.normalize("NFKC", text)
    t = _CONTROL.sub(" ", t)
    t = _DELIMITERS.sub(" ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:max_chars]


def looks_like_instructions(text: str) -> bool:
    return bool(_INJECTION_RE.search(unicodedata.normalize("NFKC", text)))


def clean_untrusted(text: str | None, max_chars: int = 300) -> CleanText:
    """Prepare a piece of untrusted text for inclusion in a prompt."""
    if not text:
        return CleanText("", False, False)
    norm = normalise(str(text), max_chars * 2)  # scan more than we keep, so padding cannot hide an injection
    if looks_like_instructions(norm):
        return CleanText(WITHHELD, True, False)
    red = redact(norm)
    return CleanText(red[:max_chars], False, red != norm)


# Names of operations the model must never be able to trigger; used by the output validator.
PROHIBITED_ACTIONS = re.compile(
    r"\b(refund_payment|capture_payment|authorize_payment|authorise_payment|cancel_payment|void_payment|create_payment|"
    r"execute_sql|run_sql|run_shell|shell_exec|http_request|fetch_url|write_file|delete_record|update_record)\b",
    re.I,
)
