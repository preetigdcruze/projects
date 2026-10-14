# AI design

The AI layer **explains, investigates and recommends. It cannot authorize, capture, refund, cancel or otherwise change a payment**, and it is optional: with the service stopped, or no model configured, every core workflow keeps working and AI screens show an explicit unavailable state.

## Components (`ai-service/app`)

| Module | Role |
|---|---|
| `providers/` | `LLMProvider` interface; `MockProvider` (deterministic, reads the same prompt a real model would), `AnthropicProvider`, `OpenAICompatibleProvider` (plain `httpx`, no vendor SDK); `ResilientProvider` (bounded retries, `Retry-After`), `RedactingProvider` (outermost wrapper) |
| `backend_client.py` | The only door to data: GET-only client with an allow-list of read paths, bound to **the caller's bearer token** |
| `evidence.py` | "Tools": retrieve payments, attempts, audit events, logs, discrepancies, processor statistics, anomalies, incidents; mint evidence ids; whitelist fields |
| `untrusted.py`, `redaction.py` | Normalisation, instruction-like text detection, secret/PII redaction |
| `diagnosis.py` | Deterministic rule-based diagnosis (always available; also the brain of the mock provider) |
| `investigator.py`, `incident_summary.py`, `analytics_agent.py`, `runbook_qa.py` | The four LLM workflows |
| `output_validation.py` | Strict parsing + semantic validation of everything the model returns |
| `anomaly.py` | Statistical detector (no LLM involved in detection) |
| `rag.py` | Runbook retrieval |
| `eval/` | Evaluation dataset and harness |

## Provider abstraction

```python
class LLMProvider(ABC):
    name: str; model: str
    def complete(self, request: LLMRequest) -> LLMResponse: ...
```

Selected by `AI_PROVIDER` = `mock` (default) | `anthropic` | `openai_compatible`. Provider specifics (endpoints, headers, payload shapes, usage fields, status-code mapping) live only in `http_providers.py`; changing vendors does not touch application code.

* **Timeouts:** `AI_PROVIDER_TIMEOUT_SECONDS`.
* **Retries:** only for retryable categories (`PROVIDER_TIMEOUT`, `PROVIDER_RATE_LIMITED`, `PROVIDER_UNAVAILABLE`), at most `AI_PROVIDER_MAX_RETRIES`, exponential backoff with jitter, `Retry-After` honored but capped at 10 s. All requests are read-only analyses, so repeating them is safe.
* **Error classification:** stable categories (`PROVIDER_AUTH_ERROR`, `PROVIDER_BAD_REQUEST`, `PROVIDER_NOT_CONFIGURED`, `PROVIDER_INVALID_RESPONSE`, …) appear in API responses, metrics and the UI.
* **Usage tracking:** prompt/completion tokens come from the provider and are stored per investigation and exported as Prometheus counters.
* **No silent fallback to the mock.** A real provider without a key becomes `UnavailableProvider`, which raises `PROVIDER_NOT_CONFIGURED`. The UI shows "unavailable"; nothing canned is presented as a model answer.
* **Redaction before egress:** `RedactingProvider` redacts the system prompt and every message (card numbers with Luhn validation, emails, IBANs, phone numbers, JWTs, bearer tokens, API-key shapes, `password=…`-style assignments, private keys). Tested by capturing the outgoing HTTP body.

## Retrieval ("tools") and permissions

All tools are **read-only** and run with the caller's identity:

| Tool | Backend endpoint (allow-listed GET only) |
|---|---|
| Payment state, attempts (processor codes, retry history) | `/api/v1/payments/{id}` |
| Audit/state history | `/api/v1/payments/{id}/events` |
| Application logs | `/api/v1/operational-logs` (INVESTIGATOR+) |
| Reconciliation discrepancies | `/api/v1/reconciliations/discrepancies` |
| Metrics | `/api/v1/analytics/{overview,payment-trends,failure-reasons,processors,timeseries}` |
| Anomalies / incidents | `/api/v1/anomalies`, `/api/v1/incidents/{id}` |
| Runbooks | `/api/v1/runbooks/search` |

`assert_allowed` rejects any other path before a request is made (refunds, admin, dev, internal, traversal, absolute URLs — see `test_backend_client.py`). `BackendClient` has no method other than `get`. There is no SQL, shell, filesystem or arbitrary HTTP tool, and none can be requested through model output because the model never selects tools: the service decides what to retrieve. If the backend answers 403 for a resource, that part of the evidence is skipped and reported in `gaps`; it is never guessed.

The single write the service performs is persisting the anomalies found by the statistical detector, via `/api/v1/internal/anomalies` with a service credential that cannot touch payments.

## Evidence and citations

Every retrieved record becomes an `Evidence` item with an id minted from the backend's identifiers (`pay:`, `att:`, `evt:`, `log:`, `disc:`, `anom:`, `stat:`, `inc:`). The prompt contains only these items. The model must cite ids; after parsing, **any cited id that is not in the retrieved set rejects the whole answer** (`FABRICATED_EVIDENCE`). UUIDs and numbers of four or more digits mentioned in narrative fields must also occur in the evidence (`UNGROUNDED_CLAIM`). Responses separate three things:

1. **`facts`** — retrieved records, rendered by the UI as *verified facts*, each linked to its payment/incident page;
2. **`findings`** — deterministic rule-based observations (also shown when no model is reachable);
3. **`analysis`** — the validated model interpretation, rendered as an *AI-generated hypothesis*, with confidence, **what the confidence level means**, alternative explanations, recommended diagnostic steps and missing information. If evidence is thin the model is instructed to set `insufficient_evidence` (and confidence is forced to `low`).

Runbook text is kept in a separate `runbookGuidance` list (`runbook:<key>@v<version>`), labelled "reference material, not evidence about this case".

## Defences against untrusted input and prompt injection

Everything originating outside the code base — log lines, payment descriptions, processor messages, runbook excerpts, even the operator's question — is untrusted.

1. **Instruction/data separation:** instructions live only in the system prompt; evidence is JSON inside `<evidence_json>` with an explicit rule that `untrusted_text` fields are data. Delimiter-like tokens (`</evidence_json>`, `<|im_start|>`, code fences) are stripped from untrusted text.
2. **Withholding:** text matching instruction-like patterns ("ignore previous instructions", "you are now…", action names such as `refund_payment`, SQL/shell fragments, "reveal the API key"…) is **replaced with a placeholder before it reaches the model**, after Unicode normalisation and scanning past padding. The flagged evidence ids are reported (`validation.injectionFlags`) and shown in the UI.
3. **Redaction** of secrets and personal data (above), and **length limits** per field, per evidence set (`AI_MAX_CONTEXT_CHARS`, `AI_MAX_EVIDENCE_ITEMS`) and for output (`AI_MAX_OUTPUT_TOKENS`).
4. **Capability limiting (the real defence):** even a fully manipulated model has no tool that can change anything. Its output is data; it is rendered as inert text.
5. **Output validation:** strict Pydantic schemas (`extra="forbid"`), citation existence, grounding, a filter for action names (`refund_payment`, `execute_sql`, …) and for claims that an action was performed ("we restarted…", "has been fixed") — the system cannot verify actions, so such statements are rejected (`PROHIBITED_ACTION_ATTEMPT`, `UNVERIFIED_ACTION_CLAIM`).
6. **Rendering:** React text nodes only; `dangerouslySetInnerHTML` is lint-banned; a unit test pushes `<script>`/`<img onerror>` through the investigation view.
7. **Abuse limits:** 64 KiB backend body limit, 32 KiB AI service limit, backend rate limit for AI POSTs (20/min/user), service-level limit per caller, gateway circuit breaker.
8. **Minimal storage:** the backend stores the question, the validated result, provider/model, token counts, latency and error category — **not prompts** — for 30 days (`ai_investigations.expires_at`).

Heuristic detection is incomplete by nature; items 4–5 bound the impact of what slips through.

## Features

* **A. Investigator** (`POST /api/v1/ai/investigations`): payment, incident or anomaly subject. Returns the structure above plus provider/model/usage/latency.
* **B. Natural-language analytics** (`POST /api/v1/ai/analytics-queries`): the model (or, if unavailable, a keyword planner) maps the question to **at most three of seven predefined operations** (`overview`, `processor_stats`, `failure_reasons`, `payment_trends`, `timeseries`, `open_discrepancies`, `recent_anomalies`). Arguments are validated against Pydantic schemas (enums, ranges, patterns; extra arguments rejected). Time windows are resolved by code (`last_hour` … `last_30_days`, never beyond the backend's 31-day cap). Queries run through the caller's token. The model then *explains* the returned numbers; any number in the explanation that cannot be traced to the results (allowing percentages derived from ratios) causes a deterministic template explanation to be used instead. The response includes the explanation, `metricsUsed`, `timeRange`, the operations with endpoints, raw results and a dashboard link.
* **C. Incident summaries** (`POST /api/v1/incidents/{id}/summarize`): failure counts, impact and timeline are computed deterministically from linked records (and say so, including that impact is a lower bound); the model writes the narrative (title, likely causes with evidence ids, key events, investigation and mitigation steps, uncertainties, missing evidence). `remediationClaims` is always `none-verified`.
* **D. Anomaly detection** (`POST /api/v1/ai/anomalies/detect`): below.
* **E. Runbook retrieval** (`POST /api/v1/ai/runbook-questions`, and runbook guidance inside investigations/incidents): PostgreSQL full-text search over versioned documents (`runbook_documents`), keyword query derived from the diagnosis label (not from untrusted text), snippets with `runbook:<key>@v<n>` references, excerpts scanned like any untrusted text. Embeddings were **not** added: with a handful of curated documents keyword search is deterministic, explainable and sufficient; a vector index would sit behind the same `search_runbooks` function if the corpus grows.

### Anomaly detection (no LLM)

For each metric (`FAILURE_RATE`, `TIMEOUT_RATE`, `PROCESSOR_LATENCY_P95`, `THROUGHPUT`, `DISCREPANCY_COUNT`) and dimension (`ALL` and each processor), the last N buckets are compared with the previous 24 buckets using a **robust z-score**: `(x − median) / max(1.4826·MAD, floor)`. Safeguards: minimum baseline length (8), minimum samples per bucket (so "1 of 2 failed" is not a 50% failure rate), scale floor (a flat baseline has MAD 0), minimum absolute/relative effect, null for zero denominators, explicit zeros for count metrics, only the meaningful direction per metric. Severity bands are multiples of the threshold `k=4`. Results are persisted with observed value, baseline, threshold, score, method, sample size and window (`UNIQUE(metric, dimension, window)` makes detection idempotent), and HIGH/MEDIUM anomalies are correlated into incidents. Thresholds are configurable (`MetricConfig`).

**Limitations and evaluation:** it assumes a mostly stationary baseline over 24 buckets (no seasonality: a daily traffic cycle can trigger or mask alerts); bucket independence is assumed; thresholds were chosen by judgment on synthetic data, not tuned. To evaluate it properly, replay historical series with labelled incidents and report precision/recall and time-to-detect per metric, sweep `k` and `min_abs_delta` to plot the trade-off, and compare against a seasonal baseline (e.g. same hour last week). `tests/test_anomaly.py` covers the numerical behavior; no claim of production accuracy is made.

## Evaluation (`ai-service/eval`)

`python -m eval.run --robustness` runs 12 synthetic investigation cases (timeout, decline, outage, discrepancy, healthy payment, **insufficient evidence**, **access-denied logs**, three **adversarial** cases with injected instructions/secrets, an anomaly and an incident) and reports:

* citation validity (raw model output vs retrieved evidence), claim support (lexical proxy), cause identification, abstention recall/false-abstention rate, mutation attempts, injection resistance, gap reporting, latency, provider failures;
* **robustness:** the same cases against a deliberately misbehaving model (fabricated evidence, action names, "I fixed it" claims, malformed JSON, timeouts, rate limits) — every bad answer must be rejected and none shown.

In **deterministic mode** the "model" is the rule-based mock, so near-perfect scores validate the pipeline and the validators, not language-model quality. **Live mode** (`--live`, requires `AI_PROVIDER`/`AI_API_KEY`) runs the same cases through a real model and prints the sample size, scoring criteria and limitations; with 12 cases it cannot support accuracy claims. No live results are recorded in this repository.

## Failure handling

| Condition | Result |
|---|---|
| Provider timeout / rate limit / outage / auth / not configured | `DEGRADED`: facts + rule-based findings + explicit notice and `errorCategory`; no analysis |
| Malformed JSON, schema violation, fabricated citation, ungrounded identifier, action name or action claim | `DEGRADED` with `INVALID_MODEL_OUTPUT` / `FABRICATED_EVIDENCE` / `UNGROUNDED_CLAIM` / `PROHIBITED_ACTION_ATTEMPT` / `UNVERIFIED_ACTION_CLAIM` |
| AI service unreachable from the backend | Investigation stored as `UNAVAILABLE` with a category (`UNREACHABLE`, `TIMEOUT`, `UPSTREAM_ERROR`, …); analytics/runbook calls return `{"status":"UNAVAILABLE"}` |
| Backend denies a resource to the caller | Listed under `gaps`; analysis proceeds on the rest |
