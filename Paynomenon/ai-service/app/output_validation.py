"""Validation of model output. The model is untrusted: its text is parsed into strict schemas, every citation is checked
against the evidence we actually retrieved, and anything that looks like an attempted action is rejected."""

from __future__ import annotations

import json
import re
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from .models import ModelInvestigation, ValidationReport
from .untrusted import PROHIBITED_ACTIONS

T = TypeVar("T", bound=BaseModel)

_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_LONG_NUMBER = re.compile(r"(?<![\w.])\d{4,}(?![\w.])")
_CLAIMS_ACTION = re.compile(
    r"\b(i|we|the system|paysense)\s+(have\s+|has\s+|had\s+)?(already\s+)?(fixed|restarted|rolled\s+back|refunded|remediated|mitigated|resolved|retried|re-ran|reran|replayed|captured|authori[sz]ed|cancell?ed|deployed|resubmitted)\b"
    r"|\b(has|have)\s+been\s+(fixed|restarted|rolled\s+back|refunded|remediated|mitigated|resolved|replayed|captured|cancell?ed)\b",
    re.I,
)


class OutputRejected(Exception):
    def __init__(self, category: str, errors: list[str]):
        super().__init__(category)
        self.category, self.errors = category, errors


def extract_json(text: str) -> Any:
    """Tolerates code fences and surrounding prose, but requires exactly one JSON object."""
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", t)
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end <= start:
        raise OutputRejected("INVALID_MODEL_OUTPUT", ["response contains no JSON object"])
    try:
        return json.loads(t[start : end + 1])
    except json.JSONDecodeError as e:
        raise OutputRejected("INVALID_MODEL_OUTPUT", [f"response is not valid JSON: {e.msg}"]) from e


def parse_model(text: str, model: type[T], report: ValidationReport) -> T:
    if PROHIBITED_ACTIONS.search(text):
        report.prohibitedActionAttempt = True
        report.errors.append("model output referenced a prohibited action")
        raise OutputRejected("PROHIBITED_ACTION_ATTEMPT", report.errors)
    try:
        return model.model_validate(extract_json(text))
    except OutputRejected as e:
        report.errors.extend(e.errors)
        raise
    except ValidationError as e:
        errors = [f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}" for err in e.errors()[:8]]
        report.errors.extend(errors)
        raise OutputRejected("INVALID_MODEL_OUTPUT", errors) from e


def check_claims_of_action(strings: list[str], report: ValidationReport) -> None:
    for s in strings:
        if _CLAIMS_ACTION.search(s):
            report.errors.append("narrative claims an action was performed, which cannot be verified")
            report.prohibitedActionAttempt = True
            raise OutputRejected("UNVERIFIED_ACTION_CLAIM", report.errors)


def check_citations(cited: list[str], known: set[str], report: ValidationReport) -> None:
    bad = sorted({c for c in cited if c not in known})
    if bad:
        report.rejectedCitations.extend(bad)
        report.errors.append(f"{len(bad)} cited evidence id(s) do not exist in the retrieved evidence")
        raise OutputRejected("FABRICATED_EVIDENCE", report.errors)


def check_grounding(texts: list[str], corpus: str, report: ValidationReport) -> None:
    """Identifiers and long numbers mentioned by the model must occur in the evidence it was given."""
    for t in texts:
        for token in _UUID.findall(t) + _LONG_NUMBER.findall(t):
            if token.lower() not in corpus:
                report.errors.append(f"'{token}' is mentioned but does not appear in the evidence")
                raise OutputRejected("UNGROUNDED_CLAIM", report.errors)


def investigation_texts(m: ModelInvestigation) -> list[str]:
    out = [
        m.summary,
        m.most_likely_explanation.statement,
        m.confidence_explanation,
        *m.recommended_diagnostic_steps,
        *m.missing_information,
    ]
    out += [c.statement for c in m.supporting_evidence] + [a.statement for a in m.alternative_explanations]
    return out


def investigation_citations(m: ModelInvestigation) -> list[str]:
    ids = list(m.most_likely_explanation.evidence_ids)
    ids += [i for c in m.supporting_evidence for i in c.evidence_ids]
    ids += [i for a in m.alternative_explanations for i in a.evidence_ids]
    return ids


def validate_investigation(text: str, known_ids: set[str], corpus: str, report: ValidationReport) -> ModelInvestigation:
    m = parse_model(text, ModelInvestigation, report)
    check_citations(investigation_citations(m), known_ids, report)
    check_claims_of_action(investigation_texts(m), report)
    check_grounding(investigation_texts(m), corpus, report)
    if not m.insufficient_evidence and not m.most_likely_explanation.evidence_ids:
        report.errors.append("explanation without evidence while claiming sufficient evidence")
        raise OutputRejected("UNSUPPORTED_EXPLANATION", report.errors)
    if m.insufficient_evidence and m.confidence != "low":
        m = m.model_copy(
            update={
                "confidence": "low",
                "confidence_explanation": m.confidence_explanation + " (confidence capped at low because the evidence is insufficient)",
            }
        )
    return m


_NUM = re.compile(r"(?<![\w.])-?\d+(?:[.,]\d+)?")


def numbers_in(obj: Any, out: set[float] | None = None) -> set[float]:
    out = out if out is not None else set()
    if isinstance(obj, bool):
        return out
    if isinstance(obj, (int, float)):
        out.add(float(obj))
        if 0 <= abs(obj) <= 1:  # a ratio may legitimately be quoted as a percentage
            out.add(round(float(obj) * 100, 1))
            out.add(round(float(obj) * 100))
    elif isinstance(obj, dict):
        for v in obj.values():
            numbers_in(v, out)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            numbers_in(v, out)
    elif isinstance(obj, str):
        for m in _NUM.findall(obj):
            try:
                out.add(float(m.replace(",", ".")))
            except ValueError:
                pass
    return out


def ungrounded_numbers(text: str, allowed: set[float]) -> list[str]:
    """Numbers in the explanation that cannot be traced to the query results (tiny ordinals 1-3 are tolerated)."""
    bad = []
    for m in _NUM.findall(text):
        try:
            x = float(m.replace(",", "."))
        except ValueError:
            continue
        if x in (1, 2, 3):
            continue
        tolerance = 1e-6 if x == int(x) else 0.051  # whole numbers must match exactly; decimals tolerate rounding of derived percentages
        if not any(abs(x - a) <= tolerance for a in allowed):
            bad.append(m)
    return bad
