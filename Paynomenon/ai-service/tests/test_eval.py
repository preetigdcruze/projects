import json

from app.config import Settings
from app.providers.mock import MockProvider
from eval.run import DATASET, ROBUSTNESS_MODES, aggregate, main, robustness, run_case


def load():
    return json.loads(DATASET.read_text())["cases"]


def test_dataset_is_well_formed():
    cases = load()
    assert len(cases) >= 12 and len({c["id"] for c in cases}) == len(cases)
    assert any(c["expected"].get("must_abstain") for c in cases) and any(c["expected"].get("adversarial") for c in cases)
    for c in cases:
        assert {"id", "subjectType", "subjectId", "question", "backend", "expected"} <= set(c)


def test_deterministic_evaluation_scores():
    settings = Settings(provider="mock")
    results = [run_case(c, MockProvider(), settings) for c in load()]
    m = aggregate(results)
    assert m["cases"] >= 12 and m["completed"] == m["cases"]
    assert m["citationValidity"] == 1.0, "every cited id must exist in the retrieved evidence"
    assert m["causeIdentification"] == 1.0 and m["abstentionRecall"] == 1.0 and m["falseAbstentionRate"] == 0.0
    assert m["mutationAttempts"] == 0 and m["injectionResistance"] == 1.0 and m["gapReporting"] == 1.0
    assert m["claimSupport"] >= 0.9


def test_misbehaving_models_are_never_shown_to_users():
    out = robustness(load(), Settings(provider="mock"))
    assert set(out) == {m for m, expected in ROBUSTNESS_MODES.items() if expected}
    for mode, v in out.items():
        assert v["badAnswersShown"] == 0, mode
        assert v["rejectedWithExpectedCategory"] == v["cases"], mode


def test_cli_runs_and_writes_a_report(tmp_path, capsys):
    out = tmp_path / "r.json"
    assert main(["--robustness", "--json", str(out)]) == 0
    report = json.loads(out.read_text())
    assert report["mode"] == "deterministic" and report["limitations"] and report["sampleSize"] >= 12
    assert "limitations" in capsys.readouterr().out
