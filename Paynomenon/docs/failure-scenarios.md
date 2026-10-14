# Failure scenarios, guarantees and recovery

Each row lists what the system does, how it recovers, and the automated test that demonstrates it (`IT` = integration test against real PostgreSQL; Kafka cases use an embedded KRaft broker).

## Guarantees (and non-guarantees)

| Area | Guarantee | Non-guarantee |
|---|---|---|
| Payment creation | A payment, its audit event, its outbox event and its idempotency record commit atomically or not at all | — |
| API idempotency | Same key + same request → one payment, same response replayed; same key + different request → 422; concurrent duplicates are safe | Keys expire after 24 h; a key used by a *different principal* is a different key |
| Processor calls | A call whose outcome is unknown is never retried blindly; it ends `UNCERTAIN` and is resolved by a read-only lookup | The real world is not simulated perfectly: a lookup `NOT_FOUND` is treated as "not executed", which a real processor with eventual consistency could contradict |
| Ledger | Every posting balances, is unique per payment+operation, immutable; refunds are reversals | Not a certified ledger |
| Events | **At-least-once** publication and delivery; handlers are idempotent; durable dedupe per consumer | **Not exactly-once end to end.** Ordering is preserved per aggregate only on the happy path (a backing-off event holds back its successors; Kafka partitions by aggregate id) |
| Dead letters | Failed events are kept with error, attempts and payload; replay is admin-only, audited, capped at 3 | Replaying cannot undo effects of other events; it is not automatic |
| AI | Never mutates payments; unavailability degrades to facts + rule findings; invalid output is rejected | Correctness of LLM interpretations is not guaranteed — they are labelled hypotheses |

## Scenarios

| # | Failure | Behavior | Recovery | Test |
|---|---|---|---|---|
| 1 | Database unavailable / failing during payment creation | `503 DATABASE_UNAVAILABLE` + `Retry-After`; nothing persisted (no payment, outbox row or idempotency record) | Client retries the same `Idempotency-Key` | `FailureScenariosIT.database failure during payment creation…` |
| 2 | DB connections severed mid-flight | A request on a dead connection may fail; the pool validates and replaces connections | Self-healing | `…severed database connections are recovered by the pool` |
| 3 | Outbox write fails inside a transaction | Whole transaction rolls back (payment, ledger, audit, idempotency); `500` without internals | Retry; key not consumed | `TransactionRollbackIT` |
| 4 | Kafka unavailable while events are being created | Business operations succeed (the outbox row is written locally). Publisher fails, backs off (exponential + jitter), then publishes after recovery; after the retry budget the row is `FAILED` and visible; ADMIN requeues | Automatic, or manual requeue | `OutboxAndConsumersIT` (3 tests), `KafkaIT.an unreachable broker…` |
| 5 | Processor **timeout, operation executed** | `202`, payment `UNCERTAIN`, one attempt, no retry. Further operations are refused (`PAYMENT_OUTCOME_UNCERTAIN`). `ProcessorTimeout` event → consumer looks up the original request id → `AUTHORIZED`. The processor saw the request exactly once | Automatic | `FailureScenariosIT.a timeout where the processor DID execute…` |
| 6 | Processor timeout, **not** executed | Same, but lookup says `NOT_FOUND` → payment returns to `CREATED`; client may authorize again | Automatic | `…never executed resolves back to CREATED` |
| 7 | Slow processor beyond the client deadline | Treated as an ambiguous timeout (the mock executes before it sleeps, so this is the dangerous variant) | Automatic | `…slow processor beyond the client deadline…` |
| 8 | Processor temporarily unavailable | Retried with the same request id (exponential backoff + jitter, bounded attempts and elapsed time). If still failing: `503 PROCESSOR_UNAVAILABLE`, payment back to `CREATED`, **idempotency key released** so the client can retry | Client retry after recovery | `…transient unavailability is retried…`, `IdempotencyIT.a transient processor outage is not stored…` |
| 9 | Sustained processor failure | Circuit opens per processor → calls rejected locally (no load on the failing dependency); half-open probes after `open-duration`; closes after successful probes. Other processors unaffected | Automatic | `…repeated failures open the circuit…`; `CircuitBreakerTest` |
| 10 | Too many concurrent processor calls | Bulkhead rejects (`PROCESSOR_REJECTED_BULKHEAD_FULL`) instead of exhausting threads | Automatic | `BulkheadTest` |
| 11 | Worker dies between "begin" and "complete" | Payment stuck in `PROCESSING/CAPTURING/REFUNDING` → sweeper (after 2 min) marks `UNCERTAIN` → lookup resolves (to the processor's truth) | Automatic | `…worker that died mid-operation…`, `…died AFTER the processor executed…`, `TransactionRollbackIT.a failure after the processor executed…` |
| 12 | Worker dies after side effect, before commit (consumer) | Transaction rolls back (effect and dedupe marker); redelivery runs it again; effect appears once | Automatic | `OutboxAndConsumersIT.a worker crash after the side effect…` |
| 13 | Consumer restarts / is down | Offsets are committed only after processing, so nothing is lost; lag is visible; on restart it catches up; a duplicate redelivery is a no-op | Automatic | `KafkaIT.a stopped consumer builds measurable lag…` |
| 14 | Duplicate event delivery | Durable dedupe → handler effect once | — | `…duplicate delivery of the same event…`, `KafkaIT.at-least-once…` |
| 15 | Poison / unparseable message | Dead-lettered (consumer `deserializer`) without blocking the partition | Admin inspects | `KafkaIT.unparseable messages…` |
| 16 | Repeated consumer failures | Bounded retries with backoff, then dead letter with error class/message/attempts; non-retryable errors go straight there | Admin replay with reason | `OutboxAndConsumersIT` (5 tests) |
| 17 | Duplicate processor callbacks | Unique `(processor, callback_id)`; second delivery acknowledged as duplicate, no state or audit change; unsigned callbacks rejected; callbacks cannot overwrite settled states | — | `…processor callback resolves an uncertain payment…`, `…valid signature…`, `…duplicate-callback outcome…` |
| 18 | Concurrent duplicate API requests | 50 parallel creates with one key → 1 payment, all `201`; concurrent captures execute once | — | `IdempotencyIT` (50-thread test) |
| 19 | Duplicate / inconsistent reconciliation records | Duplicate settlement lines are detected as `DUPLICATE_SETTLEMENT`; the same finding cannot be stored twice in a run (unique constraint) | — | `ReconciliationIT`, `ReconciliationMatcherTest` |
| 20 | AI service down / slow / rate limited / returns garbage | Investigation row stored as `UNAVAILABLE` with a category; UI says so; payments, analytics, reconciliation unaffected; gateway has its own breaker | Automatic | `FailureScenariosIT.the AI service being down…`, `AiGatewayIT` |
| 21 | LLM provider timeout / rate limit / outage | Bounded retries honoring `Retry-After`; then `DEGRADED` result with facts and rule-based findings; no fabricated answer | Automatic | `test_providers.py`, `test_investigator.py` |
| 22 | LLM returns malformed JSON, fabricated evidence ids, unverifiable "I fixed it" claims, or action names | Output rejected; reason shown; facts remain | — | `test_investigator.py`, `test_incident_and_runbooks.py`, `eval/run.py --robustness` |
| 23 | Prompt injection in logs / descriptions / processor messages / runbooks | Instruction-like text withheld from the prompt; secrets redacted; an obeying model is still caught by output validation | — | `test_investigator.py`, `test_redaction_and_untrusted.py` |
| 24 | Redis unavailable | Rate limiter falls back to per-process counters; the overview cache is skipped; correctness never depends on Redis | Automatic | by design (`RedisRateLimiter`, `AnalyticsService`) |

## Operating notes

* **What to look at first:** System Health (outbox pending/failed, dead letters, circuit states, consumer lag), then `GET /api/v1/payments?status=UNCERTAIN`.
* **Stuck outbox:** fix the broker, then `POST /api/v1/admin/events/outbox/requeue-failed`.
* **Dead letter:** read the error, fix the dependency, `POST /api/v1/admin/events/dead-letters/{id}/replay` with a reason. A replay of an event that was in fact processed is harmless.
* **Known gap:** the retention job and the stuck-payment sweeper assume a single logical scheduler per instance; running several backend instances is safe for correctness (row locks, `SKIP LOCKED`) but all of them run the jobs.
