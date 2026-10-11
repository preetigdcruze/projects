"""Redaction of sensitive values before any text leaves this service (prompts) or is stored.

The platform never stores card data, but free text (descriptions, processor messages, logs) is untrusted and could
contain it, as well as credentials and personal data. Redaction is deliberately aggressive and lossy.
"""

from __future__ import annotations

import re

_PLACEHOLDER = "[REDACTED:{}]"

# order matters: most specific first
_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)", re.S)),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b")),
    ("bearer", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}")),
    ("api_key", re.compile(r"\b(?:sk|pk|rk|xox[abp]|ghp|gho|AKIA|AIza)[-_A-Za-z0-9]{12,}\b")),
    ("secret_assignment", re.compile(r"(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|authorization|cvv|cvc|pin)\b\s*[:=]\s*\S+")),
    ("iban", re.compile(r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b")),
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("phone", re.compile(r"(?<![\w.])(?:\+\d[\d\s().-]{8,16}\d|\(\d{3}\)\s?\d{3}[ .-]\d{4}|\d{3}[ .-]\d{3}[ .-]\d{4})(?![\w.])")),
]
_CARD = re.compile(r"(?<![\w-])(?:\d[ -]?){12,18}\d(?![\w-])")


def _luhn_ok(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


def _redact_cards(text: str) -> str:
    def repl(m: re.Match[str]) -> str:
        digits = re.sub(r"\D", "", m.group(0))
        return _PLACEHOLDER.format("card_number") if 13 <= len(digits) <= 19 and _luhn_ok(digits) else m.group(0)

    return _CARD.sub(repl, text)


def redact(text: str) -> str:
    """Return text with secrets, card numbers and personal identifiers replaced by typed placeholders."""
    if not text:
        return text
    out = _redact_cards(text)
    for name, pattern in _PATTERNS:
        if name == "secret_assignment":
            out = pattern.sub(lambda m: f"{m.group(1)}={_PLACEHOLDER.format('secret')}", out)
        else:
            out = pattern.sub(_PLACEHOLDER.format(name), out)
    return out


def contains_sensitive(text: str) -> bool:
    return redact(text) != text
