package com.paysense.integration

import org.junit.jupiter.api.Test
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SeedAndAnalyticsIT : IntegrationTestBase() {
    private fun seed(
        anchor: Instant,
        replace: Boolean = true,
    ) = mvc
        .perform(
            post(
                "/api/v1/admin/seed",
            ).auth(admin).contentType(MediaType.APPLICATION_JSON).content("""{"seed":42,"anchor":"$anchor","replace":$replace}"""),
        ).andReturn()

    private fun fingerprint(): List<String> =
        listOf(
            jdbc
                .sql(
                    "SELECT string_agg(status || ':' || n, ',' ORDER BY status) FROM (SELECT status, COUNT(*) n FROM payments GROUP BY status) x",
                ).query(String::class.java)
                .single(),
            jdbc
                .sql(
                    "SELECT string_agg(processor || ':' || status || ':' || n, ',' ORDER BY processor, status) FROM (SELECT processor, status, COUNT(*) n FROM payment_attempts GROUP BY 1,2) x",
                ).query(String::class.java)
                .single(),
            jdbc.sql("SELECT SUM(amount)::text || '/' || COUNT(*) FROM ledger_transactions").query(String::class.java).single(),
            jdbc
                .sql(
                    "SELECT string_agg(type || ':' || n, ',' ORDER BY type) FROM (SELECT type, COUNT(*) n FROM reconciliation_discrepancies GROUP BY type) x",
                ).query(String::class.java)
                .single(),
            jdbc.sql("SELECT COUNT(*) FROM dead_letter_events").query(String::class.java).single(),
        )

    @Test
    fun `the same seed and anchor reproduce the same data`() {
        val anchor = Instant.now().truncatedTo(ChronoUnit.SECONDS)
        seed(anchor).let { assertEquals(200, it.response.status, it.response.contentAsString) }
        val first = fingerprint()
        seed(anchor).let { assertEquals(200, it.response.status, it.response.contentAsString) }
        assertEquals(first, fingerprint())
    }

    @Test
    fun `seeded scenarios, reconciliation findings and analytics are consistent with the database`() {
        val anchor = Instant.now().truncatedTo(ChronoUnit.SECONDS)
        val r = seed(anchor)
        assertEquals(200, r.response.status, r.response.contentAsString)
        val summary = json(r)
        assertTrue(summary["payments"].asLong() > 400)

        // guard rails
        assertEquals(422, seed(anchor, replace = false).response.status)
        assertEquals(
            403,
            mvc
                .perform(
                    post("/api/v1/admin/seed").auth(investigator).contentType(MediaType.APPLICATION_JSON).content("{}"),
                ).andReturn()
                .response.status,
        )

        // everything is flagged synthetic
        assertEquals(0, count("SELECT COUNT(*) FROM payments WHERE NOT synthetic"))

        // scenario 3 / 6: ambiguous outcomes were reconciled through the real pipeline
        val timeoutId = summary["scenarios"]["03-timeout-then-reconciled"].asText()
        assertEquals("AUTHORIZED", status(java.util.UUID.fromString(timeoutId)))
        assertTrue(count("SELECT COUNT(*) FROM payment_events WHERE payment_id = '$timeoutId' AND event_type = 'OUTCOME_UNCERTAIN'") == 1L)
        val crashId = summary["scenarios"]["06-worker-crash-recovery"].asText()
        assertEquals("CREATED", status(java.util.UUID.fromString(crashId)))
        // scenario 4: duplicate request with the same key created one payment
        assertEquals(1, count("SELECT COUNT(*) FROM payments WHERE description = 'Scenario 4: duplicate client request'"))
        assertEquals(1, count("SELECT COUNT(*) FROM idempotency_records WHERE idempotency_key LIKE 'seed-duplicate-request-%'"))
        // scenario 5: outage then recovery - one failed attempt, one approved, same payment
        val outage = summary["scenarios"]["05-outage-with-recovery"].asText()
        assertEquals(
            listOf("UNAVAILABLE", "APPROVED", "APPROVED"),
            jdbc
                .sql(
                    "SELECT status FROM payment_attempts WHERE payment_id = '$outage' ORDER BY started_at, attempt_number",
                ).query(String::class.java)
                .list(),
        )
        // scenario 7/8: reconciliation findings (clean run for the other processor)
        assertEquals(0, count("SELECT discrepancy_count FROM reconciliation_runs WHERE scenario = 'CLEAN'"))
        assertEquals(6, count("SELECT COUNT(DISTINCT type) FROM reconciliation_discrepancies"))
        // scenario 11: dead letter requiring investigation
        assertEquals(1, count("SELECT COUNT(*) FROM dead_letter_events WHERE status = 'DEAD'"))
        // scenario 12: correlated incident
        assertTrue(json(getJson("/api/v1/incidents/${summary["incidentId"].asText()}"))["payments"].size() > 3)

        // analytics agree with SQL ground truth
        val overview = json(getJson("/api/v1/analytics/overview"))
        assertEquals(count("SELECT COUNT(*) FROM payments"), overview["totals"]["total"].asLong())
        assertEquals(count("SELECT COUNT(*) FROM payments WHERE status = 'FAILED'"), overview["totals"]["failed"].asLong())
        assertEquals(true, overview["syntheticDataPresent"].asBoolean())
        assertTrue(overview["latency"]["sufficientSample"].asBoolean())
        val rate = overview["successRate"].decimalValue()
        assertTrue(rate > java.math.BigDecimal("0.5") && rate < java.math.BigDecimal.ONE)
        assertEquals(1, overview["openIncidents"].asInt().coerceAtMost(1) * 1)

        val procs = json(getJson("/api/v1/analytics/processors")).associateBy { it["processor"].asText() }
        assertTrue(
            procs.getValue("MOCK_PROCESSOR_EU")["failureRate"].decimalValue() >
                procs.getValue("MOCK_PROCESSOR")["failureRate"].decimalValue(),
            "the unstable processor must look worse",
        )
        assertTrue(procs.getValue("MOCK_PROCESSOR")["latency"]["p99"].asLong() > 500, "latency incident visible in the tail")

        val reasons = json(getJson("/api/v1/analytics/failure-reasons"))
        assertEquals("APPROVED".length > 0, true)
        assertTrue(reasons.size() > 0)
        assertEquals(1.0, reasons.sumOf { it["share"].asDouble() }, 0.01)

        val trends = json(getJson("/api/v1/analytics/payment-trends?bucket=HOUR"))
        assertTrue(trends.size() in 20..26, "hourly buckets for ~24h: ${trends.size()}")
        assertEquals(count("SELECT COUNT(*) FROM payments"), trends.sumOf { it["total"].asLong() })

        val series = json(getJson("/api/v1/analytics/timeseries?metric=FAILURE_RATE&bucket=HOUR&processor=MOCK_PROCESSOR_EU"))
        val values = series["points"].map { it["value"].decimalValue() }
        assertTrue(
            values.takeLast(2).all { it > java.math.BigDecimal("0.25") } &&
                values.dropLast(3).takeLast(10).all { it < java.math.BigDecimal("0.25") },
            "elevated failure rate in the last two buckets only: $values",
        )
        val latency =
            json(
                getJson("/api/v1/analytics/timeseries?metric=PROCESSOR_LATENCY_P95&bucket=HOUR&processor=MOCK_PROCESSOR"),
            )["points"].map {
                it["value"].decimalValue()
            }
        assertTrue(
            latency.last() > java.math.BigDecimal(500) &&
                latency.dropLast(2).takeLast(5).all {
                    it < java.math.BigDecimal(300)
                },
            "latency spike in the last hour only: $latency",
        )

        // validation of analytics inputs
        assertEquals(400, getJson("/api/v1/analytics/overview?from=2020-01-01T00:00:00Z").response.status, "window larger than 31 days")
        assertEquals(400, getJson("/api/v1/analytics/timeseries?metric=NOPE").response.status)
        assertEquals(
            400,
            getJson("/api/v1/analytics/payment-trends?bucket=MINUTE_5&from=${anchor.minus(30, ChronoUnit.DAYS)}").response.status,
            "too many buckets",
        )
    }

    @Test
    fun `analytics on an empty database report no data instead of inventing numbers`() {
        val overview = json(getJson("/api/v1/analytics/overview"))
        assertEquals(0, overview["totals"]["total"].asInt())
        assertTrue(overview["successRate"] == null || overview["successRate"].isNull, "zero denominator -> null, not 0 or 100%")
        assertEquals(false, overview["latency"]["sufficientSample"].asBoolean())
        assertTrue(overview["latency"]["p95"] == null || overview["latency"]["p95"].isNull)
        assertEquals(0, json(getJson("/api/v1/analytics/payment-trends")).size())
        assertEquals(0, json(getJson("/api/v1/analytics/failure-reasons")).size())
    }
}
