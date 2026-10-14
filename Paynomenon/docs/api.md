# API reference

Base path `/api/v1`. JSON in and out, UTC ISO-8601 timestamps, `numeric` money as JSON numbers with the currency's scale (`49.90`). Interactive docs: `http://localhost:8080/swagger-ui.html` (OpenAPI at `/v3/api-docs`; both disabled in production).

Authentication: `Authorization: Bearer <token>` from `POST /auth/login`. Roles: see [security.md](security.md). Every response carries `X-Correlation-Id` (send your own, 8–64 chars `[A-Za-z0-9._-]`, to trace a request across the backend, events and the AI service).

## Errors

All non-2xx responses share one shape and never contain stack traces:

```json
{ "code": "VALIDATION_FAILED", "message": "Invalid monetary amount", "status": 400,
  "timestamp": "2026-10-15T09:00:00Z", "path": "/api/v1/payments", "correlationId": "…",
  "details": [ { "field": "amount", "message": "EUR supports at most 2 decimal places" } ] }
```

| Status | Codes (examples) |
|---|---|
| 400 | `VALIDATION_FAILED`, `MALFORMED_REQUEST` |
| 401 | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `INVALID_SIGNATURE` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 409 | `INVALID_STATE_TRANSITION`, `OPERATION_IN_PROGRESS`, `PAYMENT_OUTCOME_UNCERTAIN`, `IDEMPOTENCY_REQUEST_IN_PROGRESS`, `ALREADY_ACKNOWLEDGED`, `ALREADY_REPLAYED`, `REPLAY_LIMIT_REACHED` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 422 | `IDEMPOTENCY_KEY_REUSED`, `PARTIAL_REFUND_NOT_SUPPORTED`, `SEED_DATA_EXISTS` |
| 429 | `RATE_LIMITED` (+ `Retry-After`) |
| 503 | `PROCESSOR_UNAVAILABLE`, `DATABASE_UNAVAILABLE` (+ `Retry-After`) |

Pagination: `?page=0&size=20` (size ≤ 100) → `{items, page, size, totalItems, totalPages}`. Sorting: `?sort=createdAt,desc` limited to allow-listed fields. Time ranges: `from`/`to` ISO-8601, at most 31 days.

## Payments

| Method & path | Role | Notes |
|---|---|---|
| `POST /payments` | INVESTIGATOR | Body `{amount, currency, merchantId, processor, description?}`. Optional `Idempotency-Key`. `201`. Currencies: EUR USD GBP JPY CHF SEK; at most the currency's minor-unit precision |
| `GET /payments` | VIEWER | Filters `status, processor, currency, merchantId, from, to, q` (id, correlation id, merchant or description fragment); sort `createdAt, updatedAt, amount, status` |
| `GET /payments/{id}` | VIEWER | Includes processor `attempts` |
| `GET /payments/{id}/events` | VIEWER | Append-only audit trail (paginated) |
| `GET /payments/{id}/ledger` | VIEWER | Balanced ledger postings |
| `POST /payments/{id}/authorize` | INVESTIGATOR | `200` completed (the payment may be `FAILED` after a decline), `202` outcome uncertain, `503` processor unavailable (payment unchanged, key released) |
| `POST /payments/{id}/capture` | INVESTIGATOR | Same status semantics |
| `POST /payments/{id}/refund` | ADMIN | **Full refunds only**; body `{amount?, reason?}`; a different amount → `422 PARTIAL_REFUND_NOT_SUPPORTED`. The original amount is never changed; a reversing ledger transaction is posted |
| `POST /payments/{id}/cancel` | INVESTIGATOR | Only from `CREATED` or `AUTHORIZED` |

State machine (`PaymentStateMachine` is the single definition):
`CREATED → PROCESSING → AUTHORIZED → CAPTURING → CAPTURED → REFUNDING → REFUNDED`, plus `FAILED`, `CANCELLED` and `UNCERTAIN` (and the "provably not executed" returns described in [architecture.md](architecture.md)).

### Idempotency-Key behavior

| Situation | Response |
|---|---|
| New key | Operation executes; response stored |
| Same key, same request, completed | Stored response replayed with `Idempotent-Replayed: true` |
| Same key, different request or operation | `422 IDEMPOTENCY_KEY_REUSED` |
| Same key while the first request is still running | `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`, `Retry-After: 1` (creation is atomic so this only applies to authorize/capture/refund) |
| In-progress record older than 60 s (crashed request) | Taken over by the next request |
| Request failed with a validation/conflict/internal error, or the processor was provably unreachable (`503`) | **Not stored**: the key is released and the client may retry |
| Processor declined (payment `FAILED`) or outcome uncertain (`202`) | **Stored**: these are deterministic outcomes and are replayed |
| Retention | 24 h |

Keys are scoped per authenticated principal.

## Processor callbacks (simulated webhooks)

`POST /processors/callbacks` — unauthenticated by bearer token, authenticated by `X-Signature` (hex HMAC-SHA256 of the raw body). Body `{processor, callbackId, paymentId, operation, result, responseCode}` → `{duplicate, applied}`. Duplicates are acknowledged without effect; a callback only changes a payment that is `UNCERTAIN` for that operation.

## Reconciliation

| Method & path | Role |
|---|---|
| `POST /reconciliations` | INVESTIGATOR — `{processor, from?, to?, scenario?}`; `scenario`: `CLEAN` or `WITH_DISCREPANCIES` (injects synthetic defects; only when simulation is enabled) |
| `GET /reconciliations`, `GET /reconciliations/{id}` | VIEWER |
| `GET /reconciliations/{id}/discrepancies?type&status` | VIEWER |
| `GET /reconciliations/discrepancies?type&status&paymentReference`, `GET /reconciliations/discrepancies/{id}` | VIEWER |
| `POST /reconciliations/discrepancies/{id}/acknowledge` | INVESTIGATOR — `{explanation}` (10–2000 chars). Records who/when/why; **does not modify any financial record** |

Discrepancy types: `MISSING_FROM_REPORT`, `MISSING_INTERNALLY`, `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `DUPLICATE_SETTLEMENT`, `UNEXPECTED_STATE`.

## Analytics (VIEWER)

`GET /analytics/overview`, `/payment-trends?bucket=MINUTE_5|MINUTE_15|HOUR|DAY`, `/failure-reasons?limit`, `/processors`, `/timeseries?metric&bucket&processor`, `/metrics`. Rates are `null` when the denominator is zero; latency percentiles are `null` unless the sample has at least 20 observations (`sufficientSample`). Volume is reported per currency and never summed across currencies.

## Incidents and anomalies

`GET /incidents?status`, `GET /incidents/{id}` (links, timeline), `POST /incidents` and `/{id}/resolve` and `/{id}/summarize` (INVESTIGATOR), `GET /anomalies`, `GET /anomalies/{id}`. `POST /internal/anomalies` is for the AI service only (service token).

## AI

| Method & path | Role | Notes |
|---|---|---|
| `POST /ai/investigations` | INVESTIGATOR | `{subjectType: PAYMENT\|INCIDENT\|ANOMALY, subjectId, question}` → `201` with `status` `COMPLETED \| DEGRADED \| UNAVAILABLE \| FAILED`, the structured `result`, provider/model/tokens/latency |
| `GET /ai/investigations/{id}`, `GET /ai/investigations?subjectType&subjectId` | VIEWER | History |
| `POST /ai/analytics-queries` | VIEWER | `{question}` → explanation, `metricsUsed`, `timeRange`, `operations`, raw `results`, `dashboardLink`; `status: UNAVAILABLE` if the AI service is down |
| `POST /ai/runbook-questions` | VIEWER | Runbook Q&A with source references |
| `POST /ai/anomalies/detect` | INVESTIGATOR | Runs the statistical detector and persists findings |
| `GET /ai/provider-status` | VIEWER | Provider health, error categories, token usage (no secrets) |

AI POSTs are rate limited (20/min/user); `429` includes `Retry-After`.

## Events, system and operations

| Method & path | Role |
|---|---|
| `GET /events/dead-letters?status`, `GET /events/outbox/stats` | VIEWER |
| `POST /admin/events/dead-letters/{id}/replay` | ADMIN — `{reason}` (10–500 chars), max 3 replays/event |
| `POST /admin/events/outbox/requeue-failed` | ADMIN |
| `GET /system/status` | VIEWER — database, Redis, AI service, event transport, outbox, dead letters, consumer lag, circuit states, simulation flag |
| `GET /operational-logs?paymentId&correlationId&component&level&from&to` | INVESTIGATOR |
| `GET /runbooks/search?q&type&limit`, `GET /runbooks/{key}` | VIEWER |
| `GET /ledger/balances` | VIEWER |
| `GET/PUT/POST /dev/simulation…` | ADMIN, only when simulation is enabled |
| `POST /admin/seed`, `/admin/reset` | ADMIN, only when simulation is enabled and not production |
| `GET /actuator/health` (public), `/actuator/prometheus` (HTTP Basic, metrics user) | |

### Example session

```bash
TOKEN=$(curl -s localhost:8080/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"username":"investigator","password":"investigator-demo-pass"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
H="Authorization: Bearer $TOKEN"

curl -s localhost:8080/api/v1/payments -H "$H" -H 'content-type: application/json' -H 'Idempotency-Key: order-1001' \
  -d '{"amount":49.99,"currency":"EUR","merchantId":"merchant-demo","processor":"MOCK_PROCESSOR","description":"Demo purchase"}'
curl -s -X POST localhost:8080/api/v1/payments/$ID/authorize -H "$H"
curl -s -X POST localhost:8080/api/v1/payments/$ID/capture   -H "$H"
curl -s localhost:8080/api/v1/payments/$ID/events -H "$H"
```
