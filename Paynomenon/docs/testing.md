# Testing

Run **one command** for the primary suite (no external services needed):

```bash
make test        # backend unit tests + AI service pytest + frontend typecheck/lint/unit tests
```

Then, with infrastructure available:

```bash
make test-integration   # backend integration tests (real PostgreSQL, embedded Kafka)
make e2e                # Playwright against a running stack
make eval               # AI evaluation (deterministic) including misbehaving-model scenarios
```

## What exists (counts are from the last full run recorded in [implementation-status.md](implementation-status.md))

| Layer | Tooling | Covers |
|---|---|---|
| Backend unit | JUnit 5, kotlin-test | state machine, money validation/precision, ledger rules, retry classification/backoff/jitter/elapsed budget, circuit breaker transitions with a fake clock, bulkhead, reconciliation matching (every discrepancy type), idempotency fingerprints/keys, simulation determinism and production inertness, rate limiter, error mapping (pool exhaustion → 503, no leaks) |
| Backend integration | Spring Boot test, real PostgreSQL, embedded KRaft Kafka, MockMvc, a stub AI server | API contract and validation, authorization matrix, idempotency incl. 50-thread races, rollback atomicity (spy on the outbox), outbox publisher retry/FAILED/requeue, consumer dedupe/retry/DLQ/replay, ambiguous timeouts, stuck-payment recovery, duplicate callbacks, DB failure and severed connections, circuit breaker, ledger constraints, reconciliation, AI gateway degradation, anomaly persistence and incident correlation, seeding determinism, analytics numbers vs SQL, runbook search, real Kafka flow incl. lag and restart |
| AI service | pytest | redaction, untrusted-text defence, provider adapters (HTTP mocked), retry/rate-limit handling, investigator (including adversarial: injection, malformed output, fabricated evidence, prohibited actions, unauthorized data), analytics planning/validation/grounding, anomaly detector, incident summaries, runbook Q&A, API auth/limits, read-only backend client, evaluation harness |
| Frontend unit | Vitest + Testing Library | API client, formatting, loading/error/empty states, AI result rendering (facts vs interpretation, XSS-inert output, degraded states) |
| End-to-end | Playwright | sign-in, dashboard, payment history/filters/pagination, failed payment inspection, AI investigation (mock provider), NL analytics, reconciliation review + acknowledgement, system health, incident view, creating/authorizing/capturing from the UI, role boundaries |

## Integration test database

Integration tests are tagged `integration` and need PostgreSQL (the schema relies on triggers, `jsonb`, row locks):

* `TEST_DATABASE_URL` (+ `TEST_DATABASE_USER`/`TEST_DATABASE_PASSWORD`) if set — what CI and Docker-less development use;
* otherwise a Testcontainers `postgres:16-alpine` when a Docker daemon is available.

There is deliberately no in-memory database fallback. Kafka tests use `spring-kafka-test`'s embedded KRaft broker, so no Docker is required for them.

```bash
# Docker-less local setup used during development of this project
make local-db                                   # role + databases on a local PostgreSQL
export TEST_DATABASE_URL=jdbc:postgresql://localhost:5432/paysense_test
make test-integration
```

## E2E prerequisites

The stack must be running: PostgreSQL, backend (`make dev-backend` or `make up`), AI service (`make dev-ai`), and either the Vite dev server (started by Playwright) or `E2E_BASE_URL`. The global setup seeds synthetic data if the database is empty. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use a preinstalled Chromium; otherwise run `npx playwright install chromium`.

## Conventions

* Tests assert behavior (state, rows, responses), not implementation calls; failure tests inject real failures (renamed table, killed connections, stopped consumer, unreachable broker, spy that throws) rather than only mocking.
* No test is disabled or weakened to obtain a green build.
