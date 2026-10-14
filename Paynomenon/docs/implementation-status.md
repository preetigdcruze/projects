# Implementation status

Last updated at the end of the initial implementation session. "Verified" means the command was actually executed and its output inspected in the authoring sandbox (4 vCPU, no Docker daemon, PostgreSQL 16 + Redis installed locally).

## Checklist

| Area | State | Verified by |
|---|---|---|
| Repository, Gradle/Kotlin build, Flyway migrations V1–V6 | done | application started against PostgreSQL; Hibernate `validate` passes |
| Payment core: money, state machine incl. `UNCERTAIN`, audit trail, cancel | done | unit + integration tests |
| Simulated processors (success, decline, timeout executed/not executed, unavailable, invalid, delayed, duplicate callback, intermittent rates), seeded determinism, runtime controls, dev-only gating | done | tests; production inertness unit-tested |
| Resilient processor client: deadline, retry + jitter, circuit breaker, bulkhead | done | unit tests + integration (breaker open/recover) |
| API idempotency (atomic create, two-phase operations, stale takeover, retention) | done | integration incl. 50-thread race |
| Ledger: double entry, DB-enforced balance/immutability/uniqueness | done | unit + integration |
| Transactional outbox, publisher with backoff/FAILED/requeue, Kafka transport + listener, in-process transport | done | integration; embedded KRaft Kafka |
| Idempotent consumers, bounded retries, DLQ, audited capped replay, lag | done | integration |
| Reconciliation engine, synthetic reports, discrepancies, acknowledgement | done | unit + integration |
| Analytics endpoints + time series, Redis cache and rate limiting (graceful without Redis) | done | integration; Redis used during manual runs only |
| Incidents, anomaly persistence/correlation, operational logs, runbooks (FTS) | done | integration |
| Security: JWT, roles, service token, actuator basic auth, request limits, HMAC callbacks | done | integration (authorization matrix) |
| Seed/reset, 12 scenarios, deterministic mode | done | integration (determinism test) + manual run |
| AI service: provider abstraction (mock/Anthropic/OpenAI-compatible), redaction, untrusted-text defences, investigator, NL analytics, incident summaries, anomaly detector, runbook Q&A, evaluation | done | 144 pytest tests; real providers tested against mocked HTTP only |
| Frontend: all pages, typed client, loading/empty/error/degraded states | done | typecheck, lint, 22 unit tests, 11 Playwright tests |
| Observability: JSON logs, correlation ids, Micrometer metrics, Prometheus (backend + AI), Grafana dashboard JSON | done (dashboard **not** loaded in Grafana here) | metrics endpoint checked in tests |
| Load tests (k6) and recorded results; before/after index experiment | done | executed; results in performance.md |
| Dockerfiles, docker-compose, nginx, CI workflow | written | YAML validated only; **never executed** (no Docker daemon) |
| Docs, ADRs, README | done | — |

## Test results actually obtained

Recorded in the final section of this file by the last full run.

Final full run, same sandbox (PostgreSQL 16 local, no Docker):

| Suite | Command | Result |
|---|---|---|
| Backend unit | `./gradlew test` | 48 tests, 0 failures |
| Backend integration (PostgreSQL via `TEST_DATABASE_URL`, embedded KRaft Kafka) | `./gradlew integrationTest` | 101 tests, 0 failures |
| Backend style | `./gradlew ktlintCheck` (ktlint 1.7.1, `.editorconfig` in `backend/`, `intellij_idea` style with some layout rules disabled) | passed |
| AI service | `pytest` | 144 passed |
| AI service lint | `ruff check .` | passed |
| AI evaluation | `python -m eval.run` / `--robustness` (deterministic mock provider) | all synthetic cases pass; robustness: 6/6 bad answers rejected in each of 6 categories. Synthetic and tiny: not a measure of model quality |
| Frontend | `tsc --noEmit`, `eslint .`, `prettier --check .`, `vitest run` | clean; 22 tests passed |
| E2E | `playwright test` against the live backend + AI service + Vite dev server | 11 passed |
| Demo | `python3 scripts/demo.py` against the live stack | all three workflows completed |
| Load tests | see [performance.md](performance.md) | recorded, not re-run in the final pass |

Note: the first demo run exposed a stale backend still bound to :8080; after restarting on the rebuilt jar the demo passed. The sandbox Playwright browser needed `PLAYWRIGHT_CHROMIUM_EXECUTABLE` pointing at the preinstalled Chromium.

## Known incomplete or unverified

* **Docker/Compose path, Kafka-in-Compose, nginx proxy, Prometheus scrape and Grafana provisioning, and the CI workflow have not been executed.** They follow standard configurations but may need small fixes on first run.
* **Real LLM providers** (Anthropic, OpenAI-compatible) are implemented and unit-tested with mocked HTTP; they were **not** called against a live API (no key). No live evaluation results exist.
* **OpenTelemetry**: tracing is configured through Micrometer; no collector was available, so export was not verified.
* **Kafka throughput** under load was not measured (only correctness with an embedded broker).
* `ktlint` is applied to the backend; `ktlintCheck` passes.
* Embeddings/vector retrieval, OIDC, MFA, partitioned tables, multi-instance job coordination are out of scope (see README "Next improvements").
