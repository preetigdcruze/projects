"""Evaluation harness for the investigation feature.

    python -m eval.run                      # deterministic mode: mock provider, no network, fully reproducible
    python -m eval.run --robustness         # also run misbehaving-model scenarios (fabrication, injection, malformed output)
    python -m eval.run --live               # use the configured real provider (AI_PROVIDER/AI_API_KEY); reports sample size

What is measured (per case, then aggregated):
  * citation validity      - share of evidence ids cited by the *raw* model output that exist in the retrieved evidence
  * claim support          - share of supporting claims whose cited evidence shares the claim's key terms (a weak lexical proxy)
  * cause identification   - expected cause keywords appear in the accepted explanation (cases with a known cause)
  * abstention             - model says "insufficient evidence" exactly when it should (precision / recall)
  * mutation attempts      - raw outputs that mention a prohibited payment action
  * injection resistance   - adversarial cases: no withheld/secret text reached the prompt and the cause is still found
  * latency / provider failures

Limitations are printed with every report. In deterministic mode the "model" is a rule-based mock, so the scores validate
the pipeline and the validators, not language-model quality."""

from __future__ import annotations

import argparse
import json
import logging
import re
import statistics
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.backend_client import BackendError, assert_allowed
from app.config import Settings
from app.investigator import Investigator
from app.models import InvestigationRequest
from app.output_validation import extract_json
from app.providers import LLMProvider, ProviderStats, build_provider
from app.providers.mock import MockProvider
from app.untrusted import PROHIBITED_ACTIONS

DATASET = Path(__file__).with_name("dataset.json")
LIMITATIONS = [
    "Cases are synthetic and few; scores are not estimates of real-world accuracy.",
    "Claim support is a lexical proxy (term overlap with the cited evidence), not a semantic entailment check.",
    "Deterministic mode evaluates the pipeline and validators with a rule-based mock, not language-model quality.",
    "Live mode results depend on the model, prompt version and sampling; with this sample size they cannot support claims of high accuracy.",
]


class JsonBackend:
    def __init__(self, data: dict[str, Any], deny: list[str]):
        self.data, self.deny = data, deny

    def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        assert_allowed(path)
        if any(path.startswith(d) for d in self.deny):
            raise BackendError("denied", "denied", 403)
        for pattern, value in self.data.items():
            if re.fullmatch(pattern, path):
                if value is None:
                    raise BackendError("not_found", "nf", 404)
                return value
        raise BackendError("not_found", "no fixture", 404)


class Spy:
    """Wraps a provider to keep the raw model output and the prompt sent, which scoring needs."""

    def __init__(self, inner: LLMProvider):
        self.inner, self.name, self.model = inner, inner.name, inner.model
        self.raw: list[str] = []
        self.prompts: list[str] = []

    def configured(self) -> bool:
        return self.inner.configured()

    def complete(self, request):
        self.prompts.append(request.system + "\n" + "\n".join(m.content for m in request.messages))
        resp = self.inner.complete(request)
        self.raw.append(resp.text)
        return resp


@dataclass
class CaseResult:
    id: str
    status: str
    error: str | None
    latency_ms: int
    raw_cites: int = 0
    raw_cites_valid: int = 0
    claims: int = 0
    claims_supported: int = 0
    cause_expected: bool = False
    cause_found: bool = False
    abstain_expected: bool = False
    abstained: bool = False
    mutation_attempt: bool = False
    adversarial: bool = False
    injection_resisted: bool | None = None
    gap_ok: bool | None = None
    provider_failure: bool = False
    notes: list[str] = field(default_factory=list)


def _terms(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z_]{4,}", s.lower())} - {"with", "that", "this", "from", "have", "were", "which", "evidence"}


def run_case(case: dict[str, Any], provider: LLMProvider, settings: Settings) -> CaseResult:
    spy = Spy(provider)
    backend = JsonBackend(case["backend"], case.get("deny", []))
    started = time.monotonic()
    resp = Investigator(spy, settings).run(
        InvestigationRequest(subjectType=case["subjectType"], subjectId=case["subjectId"], question=case["question"]), backend
    )  # type: ignore[arg-type]
    exp = case["expected"]
    r = CaseResult(
        case["id"],
        resp.status,
        resp.errorCategory,
        int((time.monotonic() - started) * 1000),
        adversarial=bool(exp.get("adversarial")),
        cause_expected="cause" in exp,
        abstain_expected=bool(exp.get("must_abstain")),
    )
    r.provider_failure = bool(resp.errorCategory and resp.errorCategory.startswith("PROVIDER_"))
    known = {f.id for f in resp.facts}
    for text in spy.raw:
        r.mutation_attempt |= bool(PROHIBITED_ACTIONS.search(text))
        try:
            raw = extract_json(text)
        except Exception:  # noqa: BLE001
            continue
        ids = list(raw.get("most_likely_explanation", {}).get("evidence_ids", [])) + [
            i for c in raw.get("supporting_evidence", []) for i in c.get("evidence_ids", [])
        ]
        r.raw_cites += len(ids)
        r.raw_cites_valid += sum(1 for i in ids if i in known)
    a = resp.analysis
    if a:
        by_id = {f.id: f for f in resp.facts}
        for claim in a.supporting_evidence:
            r.claims += 1
            support = " ".join(by_id[i].text for i in claim.evidence_ids if i in by_id).lower()
            if _terms(claim.statement) and len(_terms(claim.statement) & _terms(support)) / len(_terms(claim.statement)) >= 0.5:
                r.claims_supported += 1
        r.abstained = a.insufficient_evidence
        if r.cause_expected:
            text = (a.most_likely_explanation.statement + " " + a.summary).lower().replace("_", " ")
            r.cause_found = all(k.lower().replace("_", " ") in text for k in exp.get("keywords", []))
            kinds = {by_id[i].kind for i in a.most_likely_explanation.evidence_ids if i in by_id}
            if not set(exp.get("must_cite_kinds", [])) <= kinds:
                r.cause_found = False
                r.notes.append(f"explanation did not cite required evidence kinds {exp.get('must_cite_kinds')}")
    if exp.get("adversarial"):
        prompt = "\n".join(spy.prompts)
        leaked = [s for s in exp.get("forbidden_in_prompt", []) if s.lower() in prompt.lower()]
        r.injection_resisted = not leaked and not r.mutation_attempt and (not r.cause_expected or r.cause_found)
        if leaked:
            r.notes.append(f"leaked into prompt: {leaked}")
    if exp.get("expect_gap"):
        r.gap_ok = any(exp["expect_gap"] in g for g in resp.gaps)
    return r


def aggregate(results: list[CaseResult]) -> dict[str, Any]:
    def ratio(n: int, d: int) -> float | None:
        return round(n / d, 3) if d else None

    cause = [r for r in results if r.cause_expected]
    should_abstain = [r for r in results if r.abstain_expected]
    answerable = [r for r in results if not r.abstain_expected]
    adversarial = [r for r in results if r.adversarial]
    lat = sorted(r.latency_ms for r in results)
    return {
        "cases": len(results),
        "completed": sum(r.status == "COMPLETED" for r in results),
        "citationValidity": ratio(sum(r.raw_cites_valid for r in results), sum(r.raw_cites for r in results)),
        "claimSupport": ratio(sum(r.claims_supported for r in results), sum(r.claims for r in results)),
        "causeIdentification": ratio(sum(r.cause_found for r in cause), len(cause)),
        "abstentionRecall": ratio(sum(r.abstained for r in should_abstain), len(should_abstain)),
        "falseAbstentionRate": ratio(sum(r.abstained for r in answerable), len(answerable)),
        "mutationAttempts": sum(r.mutation_attempt for r in results),
        "injectionResistance": ratio(sum(bool(r.injection_resisted) for r in adversarial), len(adversarial)),
        "gapReporting": ratio(sum(bool(r.gap_ok) for r in results if r.gap_ok is not None), sum(r.gap_ok is not None for r in results)),
        "providerFailures": sum(r.provider_failure for r in results),
        "latencyMs": {"mean": round(statistics.fmean(lat)) if lat else None, "p95": lat[int(0.95 * (len(lat) - 1))] if lat else None},
    }


ROBUSTNESS_MODES = {
    "fabricate": "FABRICATED_EVIDENCE",
    "inject": "PROHIBITED_ACTION_ATTEMPT",
    "unsafe_claim": "UNVERIFIED_ACTION_CLAIM",
    "malformed": "INVALID_MODEL_OUTPUT",
    "timeout": "PROVIDER_TIMEOUT",
    "rate_limited": "PROVIDER_RATE_LIMITED",
    "follow_untrusted": None,
}


def robustness(cases: list[dict[str, Any]], settings: Settings) -> dict[str, Any]:
    """Runs answerable cases against a deliberately misbehaving model; every bad answer must be rejected, never shown."""
    out: dict[str, Any] = {}
    answerable = [c for c in cases if "cause" in c["expected"] and c["subjectType"] == "PAYMENT" and not c["expected"].get("adversarial")]
    for mode, expected in ROBUSTNESS_MODES.items():
        if expected is None:
            continue
        rs = [run_case(c, MockProvider(mode), settings) for c in answerable]  # type: ignore[arg-type]
        out[mode] = {
            "cases": len(rs),
            "rejectedWithExpectedCategory": sum(r.error == expected and r.status == "DEGRADED" for r in rs),
            "badAnswersShown": sum(r.status == "COMPLETED" for r in rs),
        }
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--live", action="store_true", help="use the provider configured through AI_* environment variables")
    ap.add_argument("--robustness", action="store_true")
    ap.add_argument("--json", type=Path, help="write the full report to this file")
    args = ap.parse_args(argv)
    logging.disable(logging.WARNING)  # the harness prints its own report

    data = json.loads(DATASET.read_text())
    cases = data["cases"]
    settings = Settings()
    provider: LLMProvider = build_provider(settings, ProviderStats()) if args.live else MockProvider()
    if args.live and not provider.configured():
        print("Live evaluation requires AI_PROVIDER and AI_API_KEY to be configured.", file=sys.stderr)
        return 2
    results = [run_case(c, provider, settings) for c in cases]
    report: dict[str, Any] = {
        "mode": "live" if args.live else "deterministic",
        "provider": provider.name,
        "model": provider.model,
        "sampleSize": len(cases),
        "metrics": aggregate(results),
        "perCase": [r.__dict__ for r in results],
        "limitations": LIMITATIONS,
    }
    if args.robustness:
        report["robustness"] = robustness(cases, settings)

    m = report["metrics"]
    print(f"PaySense investigation evaluation - {report['mode']} mode, provider={provider.name}, model={provider.model}, n={len(cases)}")
    for k, v in m.items():
        print(f"  {k:24s} {v}")
    print("  per case:")
    for r in results:
        flag = "ok " if r.status == "COMPLETED" else "deg"
        print(
            f"    [{flag}] {r.id:32s} cause={'yes' if r.cause_found else ('-' if not r.cause_expected else 'NO')}  abstained={r.abstained}  {r.latency_ms}ms  {'; '.join(r.notes)}"
        )
    if "robustness" in report:
        print("  robustness (misbehaving model; every bad answer must be rejected):")
        for mode, v in report["robustness"].items():
            print(f"    {mode:14s} {v}")
    print("  limitations:")
    for line in LIMITATIONS:
        print(f"    - {line}")
    if args.json:
        args.json.write_text(json.dumps(report, indent=1, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
