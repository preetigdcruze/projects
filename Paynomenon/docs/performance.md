# Performance and load testing

Everything below was **measured**, on the environment described here, with the scripts in `loadtest/`. Nothing is extrapolated. Treat the numbers as indicative of *this* laptop-class sandbox with the load generator on the same machine; they are not capacity claims.

## Environment of the recorded runs

| | |
|---|---|
| Host | 4 vCPU, 15 GiB RAM, Linux 6.18 (a cloud sandbox; **no Docker**) |
| Software | OpenJDK 21.0.12 (backend, default JVM flags), PostgreSQL 16.15 (local, default config), Redis 7.0, k6 v1.4.0 (checksum-verified release binary) |
| Topology | backend, AI service, PostgreSQL, Redis and k6 **all on the same machine** and competing for the same 4 cores |
| Backend config | development defaults: Hikari pool 15, Tomcat 100 threads, **in-process event transport** (no Kafka), processors simulated with `real-delay: true` (each processor call really sleeps 80–120 ms) |
| Data | dev database holding the ~490-payment seed set, growing during the runs |

Consequences: authorize latency is dominated by the *simulated* processor delay (≈110 ms); event "throughput" is the in-process path, **not** Kafka (there was no broker in the sandbox, so Kafka consumer/producer throughput was not measured; the embedded-Kafka integration tests prove correctness, not speed).

Raw k6 summaries of these runs are kept in [`loadtest/results/recorded/`](../loadtest/results/recorded).

## How to run

```bash
make seed                                   # optional baseline data
k6 run -e SCENARIO=throughput -e RATE=40 -e DURATION=60s loadtest/payments.js
k6 run -e SCENARIO=duplicates -e VUS=30  -e DURATION=30s loadtest/payments.js
k6 run -e SCENARIO=outage     -e RATE=20 -e DURATION=70s loadtest/payments.js   # needs PAYSENSE_SIMULATION_ENABLED=true and the admin account
./loadtest/index-experiment.sh                                                  # needs psql, k6 and `cd backend && ./gradlew bootJar`
```

Variables: `BASE_URL`, `ADMIN_PASSWORD`, `RATE` (flows/s), `DURATION`, `VUS`, `RESULT_NAME`. Every run also polls the outbox after the load and reports how long it took to drain.

## Results

### 1. Payment throughput and latency (`SCENARIO=throughput`)

Open-model (constant arrival rate) flows: `POST /payments` (new idempotency key) → `authorize` → 50% `capture`; 60 s / 40 s.

| Arrival rate | Requests (rate) | Errors | create p50 / p95 / p99 | authorize p50 / p95 / p99 | All requests p50 / p95 / p99 |
|---|---|---|---|---|---|
| 40 flows/s, 60 s | 6,013 (99/s) | 0.00% | 4.7 / 7.7 / 16.3 ms | 110.7 / 129.9 / 137.2 ms | 97.9 / 128.9 / 134.9 ms |
| 150 flows/s, 40 s | 14,945 (366/s) | 0.00% | 8.8 / 37.2 / 128.3 ms | 125.0 / 174.4 / 252.2 ms | 109.4 / 162.9 / 230.5 ms |

The system did **not** saturate at 150 flows/s on this machine, so the knee of the curve was not found. Tail latency grows with load (create p99 16 → 128 ms) as the CPU is shared with the load generator and PostgreSQL.

### 2. Concurrent duplicate requests (`SCENARIO=duplicates`)

30 virtual users for 30 s; each iteration sends **5 identical `POST /payments` with the same `Idempotency-Key` concurrently** (`http.batch`).

| Completed batches | Requests (rate) | HTTP errors | Batches where all 5 responses were `201` with the same payment id |
|---|---|---|---|
| 6,755 | 33,779 (1,101/s) | 0.00% | **6,755 / 6,755 (100%)** |

Database cross-check after the run: among payments created by this scenario there are 6,757 `POST /payments` idempotency records, 6,757 distinct payments and 6,757 distinct keys — **no key produced more than one payment**. (The two records beyond the 6,755 completed batches belong to batches still in flight when the run ended.) The integration test `IdempotencyIT` asserts the same invariant with 50 threads.

### 3. Processor outage and recovery (`SCENARIO=outage`)

20 flows/s for 70 s; at t=20 s both processors are switched to 100% `UNAVAILABLE` (via the development simulation API), at t=40 s switched back. A probe issues create+authorize every 0.5 s from t=40 s until one succeeds.

| Requests | HTTP errors | `503` while processors were unavailable | Of which rejected locally by the open circuit | Time from "processors recovered" to the first successful authorization |
|---|---|---|---|---|
| 2,855 | 22.4% (all `503 PROCESSOR_UNAVAILABLE`, payments left in `CREATED`, idempotency keys released) | 618 | 615 (99.5%) | **11.4 s** |

What this shows: after a few retried failures the breaker opened, so ~99% of the outage traffic was rejected in microseconds without touching the dead processor (no retry storm). Recovery is governed by the breaker's `open-duration` (15 s, opened a few seconds into the outage) followed by half-open probing — a deliberate trade-off between hammering a recovering dependency and restoring service quickly. No payment was lost or double-processed; the k6 `flow_success` threshold is *expected* to fail for this scenario because requests rejected after recovery but before the half-open probe count as failures.

### 4. Event processing throughput

Measured after each throughput run (in-process transport): 6,009 events published during the 60 s / 40-flows-per-second run and 14,941 during the 150-flows-per-second run (≈370 events/s); the outbox was **empty 0.5 s after the load stopped** (that is the publisher's poll interval) with 0 failed rows. Kafka transport throughput and consumer lag under load were not measured (no broker available); lag measurement itself is exercised by `KafkaIT`.

### 5. Before/after optimization: trigram indexes for payment search

**Change:** migration `V6__payment_search_indexes.sql` adds `pg_trgm` GIN indexes on `lower(coalesce(description,''))` and `lower(merchant_id)`. Without them the free-text search on the payments page (`lower(...) LIKE '%term%'`) cannot use an index.

**Setup:** `./loadtest/index-experiment.sh` — scratch database with **500,000** synthetic payments (status mix, 50 merchants, descriptions `order-N`), second backend instance on :8082, k6 `search` scenario at a constant **20 requests/s for 30 s** (`GET /payments?q=order-<random N>&size=20`), run first without the two indexes, then with them.

| | SQL: `count(*)` (EXPLAIN ANALYZE) | SQL: newest 20 (EXPLAIN ANALYZE) | HTTP p50 | HTTP p95 | HTTP p99 | HTTP errors | Achieved rate |
|---|---|---|---|---|---|---|---|
| **Without** indexes | 72.4 ms (parallel seq scan) | 227.4 ms (parallel index scan on `created_at` + filter) | 3,215 ms | 6,015 ms | 7,593 ms | **55.3%** | 15.3/s |
| **With** indexes | 7.2 ms (BitmapOr of trigram + correlation-id indexes) | 6.1 ms | **11.2 ms** | **17.1 ms** | 21.2 ms | 0.00% | 20.1/s |

Without the indexes every search ran a multi-worker scan, 20 searches/s saturated the 4 cores and exhausted the 15-connection pool (`Connection is not available, request timed out after 3000ms`); 55% of requests failed. With the indexes the same load is trivial (p95 17 ms). The runs also exposed a real bug that was then fixed: pool exhaustion surfaced as a `500`; it is now mapped to a retryable `503 DATABASE_UNAVAILABLE` (`GlobalExceptionHandlerTest`). Selectivity matters: the test term matches one row; broad terms (matching many rows) benefit much less.

An earlier attempt with a status/created index showed **no meaningful gain** (the planner already served that query with the `created_at` index), so it was not claimed as an optimization.

## Your results

Record your own runs here (same scenario names) together with hardware, topology (Docker or not, Kafka or in-process), PostgreSQL settings, and data size.

| Date | Scenario | Parameters | Hardware / topology | p50 | p95 | p99 | Errors | Notes |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |

## Reading the numbers responsibly

* Latency of `authorize` is mostly the simulated processor delay; set `PAYSENSE_SIMULATION_REAL_DELAY=false` to measure the platform itself.
* With the load generator on the same host, absolute numbers are pessimistic for the server and optimistic about network cost.
* Single runs were recorded; no confidence intervals. Repeat runs before drawing conclusions about small differences.
