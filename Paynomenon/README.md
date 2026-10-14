# PaySense — AI-powered payment intelligence platform

A **simulated** payment platform that takes payment requests through a deterministic lifecycle, tracks outcomes, reconciles them against (synthetic) processor settlement reports, and uses an **independent, read-only AI layer** to help engineers investigate failures and spot unusual behavior.

> **Simulation only.** No real banking network, card data or money is involved. Processors are mocks; amounts and merchants are synthetic. This is a portfolio project, not a certified payment or accounting system, and it makes no claim of financial-grade production readiness.

The project folder in the `projects` repository is `Paynomenon/`; the product is called PaySense.

## The problem it explores

Payments fail in confusing ways: a processor times out *after* executing a charge, a client retries a request, a message is delivered twice, a settlement file disagrees with the books. PaySense is a working model of how to keep those situations **correct** (idempotency, state machine, immutable ledger, outbox, reconciliation) and **diagnosable** (audit trail, metrics, correlation ids, evidence-backed AI investigation), while keeping AI strictly advisory.

## Architecture at a glance

```
 React dashboard ──► Payment Core (Kotlin, Spring Boot modular monolith) ──► PostgreSQL
 (nginx, same-origin)   payments · processors · idempotency · ledger · events (outbox/Kafka)
                        reconciliation · analytics · incidents · security · observability
                              │  ▲                         │            ▲
                              │  │ read-only GETs with     ▼            │
                              ▼  │ the caller's own JWT   Kafka     Redis (rate limits, cache)
                        AI Intelligence Layer (Python, FastAPI)
                        investigator · NL analytics · anomaly detector · incident summaries · runbook RAG
                              └─► LLMProvider interface: mock (default) | Anthropic | OpenAI-compatible
```

Diagrams (request flow, outbox/event flow, AI investigation flow) and the full responsibility table: **[docs/architecture.md](docs/architecture.md)**.

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Components, Mermaid diagrams, transaction boundaries, idempotency layers |
| [docs/api.md](docs/api.md) | Endpoint reference, error model, idempotency behavior, examples |
| [docs/data-model.md](docs/data-model.md) | Schema, constraints, indexing, retention |
| [docs/failure-scenarios.md](docs/failure-scenarios.md) | 24 failure modes: behavior, recovery, guarantees **and non-guarantees**, tests |
| [docs/ai-design.md](docs/ai-design.md) | Provider abstraction, tools and permissions, prompt-injection defences, citations, evaluation |
| [docs/security.md](docs/security.md) | AuthN/Z, secrets, hardening, limits |
| [docs/testing.md](docs/testing.md) | Test strategy and how to run each layer |
| [docs/performance.md](docs/performance.md) | Load-test setup and **measured** results |
| [docs/adr/](docs/adr) | Decision records: modular monolith, outbox + idempotent consumers, AI isolation |
| [docs/implementation-status.md](docs/implementation-status.md) | Checklist, what was verified and how, what is incomplete |

## Key engineering decisions

* **Money is never a float.** `BigDecimal` + `numeric(19,4)` + ISO currency precision; excess precision is rejected, not rounded; volumes are per currency.
* **One state machine** (`PaymentStateMachine`) for all transitions, with a first-class **`UNCERTAIN`** state: a processor timeout does not mean "failed". Uncertain outcomes are resolved by a read-only lookup of the original request id, never by a blind retry.
* **No locks or transactions across the processor call.** Authorize/capture/refund run as begin-tx → call → result-tx; crashed workers leave an in-flight payment that a sweeper turns into `UNCERTAIN` and reconciles.
* **Three idempotency layers:** API (`Idempotency-Key`, unique constraint), processor (stable request id), consumer (`processed_events`).
* **Transactional outbox + at-least-once + idempotent handlers**, bounded retries with jittered backoff, dead-letter table, audited replay. Explicitly *not* exactly-once end to end.
* **Immutable double-entry ledger** enforced with DB triggers (balance, immutability), unique posting per payment+operation, reversals instead of edits.
* **AI is advisory and isolated:** separate process, GET-only allow-listed tools that run with the caller's identity, untrusted text withheld/redacted, strict output validation with citation checks, verified facts shown apart from AI interpretation. The service works without any LLM key (deterministic mock) and degrades honestly when a real provider is unavailable.

## Prerequisites

| Path | Needs |
|---|---|
| **Docker (full stack, Kafka)** | Docker with Compose v2 |
| **No Docker (what this repository was developed with)** | JDK 21, Python 3.12+, Node 22+, PostgreSQL 14+ (with `pg_trgm`), optionally Redis; Kafka is **not** needed (in-process event transport) |
| Load tests | [k6](https://k6.io) |

## Quick start (Docker)

```bash
make setup      # creates .env with random secrets; installs Python/Node deps for local tooling
make up         # builds and starts postgres, redis, kafka, backend, ai-service, frontend
make seed       # loads reproducible synthetic data (seed 42)
make demo       # walks through three complete workflows
```

Open **http://localhost:3000** (UI), http://localhost:8080/swagger-ui.html (API docs, development only). Add `PROFILES=observability make up` for Prometheus (:9090) and Grafana (:3001, dashboard "PaySense operations").

> The Compose file, Dockerfiles and the CI Compose job were written and statically validated (YAML parsing) but **could not be started in the authoring sandbox, which has no Docker daemon**. The same application code was run end to end without Docker (below).

## Quick start (no Docker)

```bash
make local-db                 # role + databases on a local PostgreSQL (once)
make setup                    # Python venv + npm install
make dev-backend              # :8080, in-process event transport, Redis optional
make dev-ai                   # :8090, mock LLM provider
make dev-frontend             # :5173, proxies /api to :8080
make seed && make demo
```

Run `make help` for every target.

### Development accounts

Created at startup only when `PAYSENSE_DEMO_USERS_ENABLED=true` and `PAYSENSE_ENV` is not `production`. Passwords are configurable (`PAYSENSE_DEMO_*_PASSWORD`); the defaults below are for local use only.

| User | Password (default) | Role |
|---|---|---|
| `viewer` | `viewer-demo-pass` | read dashboards and transactions |
| `investigator` | `investigator-demo-pass` | + create/authorize/capture payments, reconciliation, acknowledge discrepancies, AI investigations |
| `admin` | `admin-demo-pass` | + refunds, dead-letter replay, seeding, simulation controls |

## Configuration

All configuration is environment-driven; see **[.env.example](.env.example)** for every key with comments. Highlights: `PAYSENSE_ENV`, database and secrets, `PAYSENSE_EVENTS_TRANSPORT` (`kafka` | `in-process`), `PAYSENSE_SIMULATION_ENABLED`, and the AI keys `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY`, `AI_API_BASE_URL`. Retry, circuit-breaker, outbox, analytics and retention settings have safe defaults in `backend/src/main/resources/application.yml`.

## Synthetic data and demo scenarios

`make seed` (admin only, refused in production) runs the **real domain services** with a pinned clock and a seeded simulator — same seed and anchor time give the same data. It produces ~490 payments over 24 hours and these scenarios:

| # | Scenario | Where to look |
|---|---|---|
| 1 | Successful payment | `01-successful-payment` in the seed response |
| 2 | Insufficient funds | `02-…` (status `FAILED`, code `INSUFFICIENT_FUNDS`) |
| 3 | Processor timeout, later reconciled | `03-…` (audit trail shows `OUTCOME_UNCERTAIN` → `OUTCOME_RESOLVED`) |
| 4 | Duplicate client request with one idempotency key | `04-…` (one payment, one record) |
| 5 | Temporary outage with recovery | `05-…` (attempts: UNAVAILABLE, APPROVED) |
| 6 | Worker crash while processing | `06-…` (stuck `PROCESSING` → sweeper → `UNCERTAIN` → lookup → `CREATED`) |
| 7, 8 | Amount mismatch, duplicate settlement | Reconciliation page, run with injected defects (six discrepancy types) |
| 9 | Elevated failure rate | processor `MOCK_PROCESSOR_EU`, last 2 hours |
| 10 | Latency anomaly | processor `MOCK_PROCESSOR`, last hour |
| 11 | Dead-letter event | System Health → Dead-letter queue |
| 12 | Incident with correlated failures | Incidents page |

Anomalies are detected by `POST /api/v1/ai/anomalies/detect` (System Health → "Run anomaly detection"; `make demo` does it too). The seed is idempotent: re-running without `REPLACE=1` is refused.

`make demo` (`scripts/demo.py`) narrates three workflows end to end: (1) lifecycle + idempotent replay + ledger + refund, (2) ambiguous timeout → automatic reconciliation → AI investigation with cited evidence, (3) reconciliation with injected defects → acknowledgement → incident → AI summary → natural-language analytics.

## Example API requests

```bash
TOKEN=$(curl -s localhost:8080/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"username":"investigator","password":"investigator-demo-pass"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
H="Authorization: Bearer $TOKEN"

# create (idempotent), authorize, capture
curl -s localhost:8080/api/v1/payments -H "$H" -H 'content-type: application/json' -H 'Idempotency-Key: order-1001' \
  -d '{"amount":49.99,"currency":"EUR","merchantId":"merchant-demo","processor":"MOCK_PROCESSOR","description":"Demo purchase"}'
curl -s -X POST localhost:8080/api/v1/payments/$ID/authorize -H "$H"
curl -s -X POST localhost:8080/api/v1/payments/$ID/capture   -H "$H"

# repeating the first request replays the stored response (header Idempotent-Replayed: true);
# changing the amount with the same key returns 422 IDEMPOTENCY_KEY_REUSED
```

More examples and the full reference: [docs/api.md](docs/api.md).

## Triggering failure scenarios

Available when `PAYSENSE_SIMULATION_ENABLED=true` (development):

* **Per payment**, put a marker in the description: `[sim:insufficient_funds]`, `[sim:timeout]` (executed, ambiguous), `[sim:timeout_not_executed]`, `[sim:unavailable]`, `[sim:invalid]`, `[sim:delayed]`, `[sim:duplicate_callback]` — also selectable in the "New payment" form.
* **Globally** (ADMIN): `PUT /api/v1/dev/simulation/MOCK_PROCESSOR` with rates, e.g. `{"timeoutRate":0.2,"timeoutExecutedRatio":1.0,"unavailableRate":0.1}`; force the next N outcomes with `POST /api/v1/dev/simulation/{processor}/force`; reset with `POST /api/v1/dev/simulation/reset`; inspect circuits with `GET /api/v1/dev/simulation/circuits`.
* Crash a worker: `PaymentOperationService.beginOnly` (used by the seed and tests) leaves a payment in flight; the sweeper reconciles it after 2 minutes.
* Kafka outage: stop the `kafka` container; payments keep working, System Health shows the outbox backlog, and events flow after restart.

## Using the AI investigator

1. Sign in as `investigator` (or `admin`) → **AI Investigation**.
2. Pick a failed/uncertain payment (or an incident / anomaly), keep or edit the question, **Run investigation**.
3. Read the result in three clearly separated panels: **Verified facts** (retrieved records, linked to their pages) · **AI-generated interpretation** (most likely explanation, confidence *with its meaning*, alternatives, diagnostic steps, missing information; every claim cites an evidence id that exists) · **Runbook guidance** (reference material, not evidence).
4. If the model is unavailable or its answer fails validation you still get the facts and rule-based findings plus an explicit notice. The *Ask analytics* and *Ask runbooks* tabs answer questions from predefined queries and versioned runbooks.

### Configuring a real LLM provider

```bash
# .env — the key lives only in the AI service; the browser never sees it
AI_PROVIDER=anthropic              # or openai_compatible
AI_MODEL=claude-sonnet-5-5         # any model id your account supports
AI_API_KEY=...                     # never commit
# AI_API_BASE_URL=https://api.openai.com/v1   # openai_compatible only (also works for vLLM/Ollama/LiteLLM)
make up                            # or restart `make dev-ai`
```

`GET /api/v1/ai/provider-status` (and System Health) shows provider, token counts and recent error categories. A missing key results in `PROVIDER_NOT_CONFIGURED` — it never silently falls back to the mock. Live-model evaluation: `cd ai-service && python -m eval.run --live` (prints sample size, criteria and limitations; no live results are included in this repository).

## Tests

```bash
make test               # primary suite: backend unit + AI pytest + frontend unit (+ typecheck, lint)
make test-integration   # backend integration (real PostgreSQL, embedded Kafka)
make e2e                # Playwright, against a running stack
make eval               # AI evaluation + misbehaving-model robustness
make lint               # ktlint, ruff, eslint, prettier
```

What is covered and how: [docs/testing.md](docs/testing.md). Results actually obtained for this repository: [docs/implementation-status.md](docs/implementation-status.md).

## Load tests

```bash
make load-test                                   # throughput scenario (k6)
k6 run -e SCENARIO=duplicates -e VUS=30 -e DURATION=30s loadtest/payments.js
k6 run -e SCENARIO=outage -e RATE=20 -e DURATION=70s loadtest/payments.js
./loadtest/index-experiment.sh                   # before/after: trigram indexes on a 500k-row table
```

Scenarios, hardware assumptions, **measured numbers** and a place for your own results: [docs/performance.md](docs/performance.md). Nothing in this README states a performance figure.

## Observability

Structured JSON logs with correlation ids (HTTP → events → consumers → AI service); Prometheus metrics at `/actuator/prometheus` (HTTP Basic) and `/metrics` on the AI service — payment outcomes, processor latency histograms, retries, circuit state, outbox backlog/age, dead letters, event handling, AI latency/errors/tokens; low-cardinality labels only. Health: `/actuator/health/liveness` vs `/actuator/health/readiness` (readiness includes the database). A Grafana dashboard is provisioned under the `observability` profile. OpenTelemetry tracing is wired through Micrometer (`management.tracing`, OTLP endpoint via `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, 10% sampling); it was **not** verified against a collector.

## Current limitations

* Everything is simulated; the ledger is intentionally minimal (two accounts, no fees/FX/periods) and not an accounting system.
* Local JWT auth with HS256 and demo users is a stand-in for an identity provider; no MFA, lockout or revocation.
* A single Kafka partition key per payment gives per-payment ordering on the happy path only; handlers are order-tolerant by design.
* Anomaly detection is a rolling-window baseline without seasonality; thresholds are untuned (see [docs/ai-design.md](docs/ai-design.md)).
* Embeddings/vector retrieval are not implemented (keyword full-text search over a small curated corpus).
* The Docker/Compose/CI-compose path and OpenTelemetry export are unverified in the authoring environment.
* Retention/sweeper jobs run on every backend instance.

## Next improvements

1. Replace local auth with OIDC (e.g. Keycloak in Compose) and move the SPA to a cookie-based BFF.
2. Seasonality-aware anomaly baselines evaluated against labelled historical incidents; a live-model evaluation run published with sample size and confidence intervals.
3. Change-data-capture outbox publishing, partitioned `payment_events`/`outbox_events` with time-based retention, and a read replica for analytics.
