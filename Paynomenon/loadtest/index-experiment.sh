#!/usr/bin/env bash
# Before/after experiment for one concrete optimisation: the pg_trgm GIN indexes added in migration V6.
# Scenario: free-text search on the payments page (`?q=order-12345`) over a large table.
#   1. creates a scratch database `paysense_load` and starts a second backend on :8082 against it (migrations create the schema)
#   2. bulk-inserts $ROWS synthetic payments
#   3. runs the k6 `search` scenario WITHOUT the indexes, then WITH them, and prints EXPLAIN ANALYZE for the query each time
# Requires: psql, k6, a built backend (`cd backend && ./gradlew bootJar`). Uses the PG* environment variables for the server.
set -euo pipefail
cd "$(dirname "$0")/.."
ROWS="${ROWS:-500000}"
RATE="${RATE:-20}"
DURATION="${DURATION:-30s}"
PGHOST="${PGHOST:-localhost}"; PGUSER="${PGUSER:-paysense}"; export PGPASSWORD="${PGPASSWORD:-paysense}"
DB=paysense_load
psql -h "$PGHOST" -U "$PGUSER" -d postgres -qc "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"

PAYSENSE_DB_URL="jdbc:postgresql://$PGHOST:5432/$DB" PAYSENSE_DB_USER="$PGUSER" PAYSENSE_DB_PASSWORD="$PGPASSWORD" SERVER_PORT=8082 \
  PAYSENSE_REDIS_ENABLED=false PAYSENSE_SCHEDULING_ENABLED=false \
  java -jar backend/build/libs/paysense-backend.jar >/tmp/paysense-load-backend.log 2>&1 &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf localhost:8082/actuator/health >/dev/null && break; sleep 1; done

psql -h "$PGHOST" -U "$PGUSER" -d $DB -q <<SQL
INSERT INTO payments (id, merchant_id, amount, currency, processor, description, status, correlation_id, created_by, synthetic, version, created_at, updated_at)
SELECT gen_random_uuid(), 'merchant-' || (g % 50), (5 + (g % 20000) / 100.0)::numeric(19,4), 'EUR',
       CASE WHEN g % 2 = 0 THEN 'MOCK_PROCESSOR' ELSE 'MOCK_PROCESSOR_EU' END, 'order-' || g, status, 'corr-' || g, 'bulk', true, 0, ts, ts
  FROM (SELECT g, ts,
               CASE WHEN r < 0.05 THEN 'FAILED' WHEN r < 0.75 THEN 'CAPTURED' WHEN r < 0.95 THEN 'AUTHORIZED' WHEN r < 0.955 THEN 'UNCERTAIN' ELSE 'CREATED' END AS status
          FROM (SELECT g, random() AS r, now() - (random() * 90) * interval '1 day' AS ts FROM generate_series(1, $ROWS) g) x) y;
VACUUM ANALYZE payments;
SQL

Q="'%order-123456%'"
QUERY="EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) SELECT count(*) FROM payments WHERE lower(coalesce(description, '')) LIKE $Q OR correlation_id = 'order-123456' OR lower(merchant_id) LIKE $Q"
QUERY2="EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) SELECT * FROM payments WHERE lower(coalesce(description, '')) LIKE $Q OR correlation_id = 'order-123456' OR lower(merchant_id) LIKE $Q ORDER BY created_at DESC, id DESC LIMIT 20"
run() { # $1 = label, $2 = result name
  echo "================ $1 ================"
  psql -h "$PGHOST" -U "$PGUSER" -d $DB -c "$QUERY" -c "$QUERY2" | grep -E "Scan|Execution Time|Sort|Limit|Aggregate|BitmapOr" || true
  k6 run --quiet -e BASE_URL=http://localhost:8082 -e SCENARIO=search -e ROWS="$ROWS" -e RATE="$RATE" -e DURATION="$DURATION" -e RESULT_NAME="search-$2" loadtest/payments.js 2>&1 | grep -E "search |requests:|http errors" || true
}

psql -h "$PGHOST" -U "$PGUSER" -d $DB -qc "DROP INDEX IF EXISTS idx_payments_description_trgm" -c "DROP INDEX IF EXISTS idx_payments_merchant_trgm" -c "VACUUM ANALYZE payments"
run "WITHOUT the trigram indexes" without-index
psql -h "$PGHOST" -U "$PGUSER" -d $DB -qc "CREATE INDEX idx_payments_description_trgm ON payments USING gin (lower(coalesce(description, '')) gin_trgm_ops)" -c "CREATE INDEX idx_payments_merchant_trgm ON payments USING gin (lower(merchant_id) gin_trgm_ops)" -c "VACUUM ANALYZE payments"
run "WITH the trigram indexes" with-index
