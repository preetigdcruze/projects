package com.paysense.integration

import com.paysense.events.OutboxPublisher
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class ReconciliationIT : IntegrationTestBase() {
    @Autowired lateinit var publisher: OutboxPublisher

    private fun capture(
        amount: String = "25.00",
        currency: String = "EUR",
        processor: String = "MOCK_PROCESSOR",
    ): UUID {
        val id = newPaymentId(paymentBody(amount, currency, processor))
        operate(id, "authorize")
        operate(id, "capture")
        return id
    }

    private fun startRun(
        processor: String = "MOCK_PROCESSOR",
        scenario: String = "CLEAN",
        token: String = investigator,
    ) = mvc
        .perform(
            post(
                "/api/v1/reconciliations",
            ).auth(token).contentType(MediaType.APPLICATION_JSON).content("""{"processor":"$processor","scenario":"$scenario"}"""),
        ).andReturn()

    private fun seedLines(n: Int = 8) {
        repeat(n) { capture("${10 + it}.00") }
        val refunded = capture("99.00")
        operate(refunded, "refund", admin)
        newPaymentId().also { operate(it, "authorize") } // authorized but never captured: no settlement expected
    }

    @Test
    fun `a clean report matches completely and produces no discrepancies`() {
        seedLines()
        val run = json(startRun())
        assertEquals("COMPLETED", run["status"].asText())
        assertEquals(10, run["internalCount"].asInt(), "9 captures + 1 refund")
        assertEquals(10, run["reportCount"].asInt())
        assertEquals(10, run["matchedCount"].asInt())
        assertEquals(0, run["discrepancyCount"].asInt())
    }

    @Test
    fun `seeded defects are detected as exactly the injected discrepancy types`() {
        seedLines()
        val run = json(startRun(scenario = "WITH_DISCREPANCIES"))
        assertEquals("COMPLETED", run["status"].asText())
        val items = json(getJson("/api/v1/reconciliations/${run["id"].asText()}/discrepancies"))["items"]
        assertEquals(
            setOf(
                "AMOUNT_MISMATCH",
                "CURRENCY_MISMATCH",
                "DUPLICATE_SETTLEMENT",
                "MISSING_FROM_REPORT",
                "MISSING_INTERNALLY",
                "UNEXPECTED_STATE",
            ),
            items.map { it["type"].asText() }.toSet(),
        )
        assertEquals(6, run["discrepancyCount"].asInt())
        val amount = items.first { it["type"].asText() == "AMOUNT_MISMATCH" }
        assertEquals(1, amount["reportAmount"].decimalValue().subtract(amount["internalAmount"].decimalValue()).toInt())
        assertEquals("OPEN", amount["status"].asText())
        // each finding was announced as an event and reached the incident consumer
        assertEquals(6, count("SELECT COUNT(*) FROM outbox_events WHERE event_type = 'ReconciliationDiscrepancyDetected'"))
        while (publisher.publishBatch() > 0) { /* drain */ }
        val incident = json(getJson("/api/v1/incidents"))["items"][0]
        assertTrue(incident["title"].asText().contains("Reconciliation discrepancies"))
        assertEquals(6, incident["counts"]["discrepancy"].asInt())
    }

    @Test
    fun `filters by type and status and pagination work`() {
        seedLines()
        val run = json(startRun(scenario = "WITH_DISCREPANCIES"))["id"].asText()
        val dupes = json(getJson("/api/v1/reconciliations/$run/discrepancies?type=DUPLICATE_SETTLEMENT"))
        assertEquals(1, dupes["totalItems"].asInt())
        assertEquals(2, dupes["items"][0]["details"]["count"].asInt())
        assertEquals(3, json(getJson("/api/v1/reconciliations/$run/discrepancies?size=3"))["items"].size())
        assertEquals(0, json(getJson("/api/v1/reconciliations/$run/discrepancies?status=ACKNOWLEDGED"))["totalItems"].asInt())
        assertEquals(400, getJson("/api/v1/reconciliations/$run/discrepancies?type=NOPE").response.status)
        assertEquals(404, getJson("/api/v1/reconciliations/${UUID.randomUUID()}").response.status)
        assertEquals(1, json(getJson("/api/v1/reconciliations"))["totalItems"].asInt())
    }

    @Test
    fun `acknowledging records an explanation but never touches financial records`() {
        seedLines()
        val run = json(startRun(scenario = "WITH_DISCREPANCIES"))["id"].asText()
        val d = json(getJson("/api/v1/reconciliations/$run/discrepancies?type=AMOUNT_MISMATCH"))["items"][0]["id"].asText()
        val ledgerBefore =
            count("SELECT COUNT(*) FROM ledger_entries") to
                jdbc.sql("SELECT COALESCE(SUM(amount),0)::text FROM ledger_entries").query(String::class.java).single()
        val paymentsBefore =
            jdbc
                .sql(
                    "SELECT string_agg(id::text || status || amount::text, ',' ORDER BY id) FROM payments",
                ).query(String::class.java)
                .single()
        val url = "/api/v1/reconciliations/discrepancies/$d/acknowledge"

        fun ack(
            token: String,
            text: String?,
        ) = mvc
            .perform(
                post(url).auth(token).contentType(MediaType.APPLICATION_JSON).content(
                    if (text ==
                        null
                    ) {
                        "{}"
                    } else {
                        """{"explanation":"$text"}"""
                    },
                ),
            ).andReturn()

        assertEquals(403, ack(viewer, "processor rounding issue confirmed").response.status)
        assertEquals(400, ack(investigator, "short").response.status)
        assertEquals(400, ack(investigator, null).response.status)
        val ok = ack(investigator, "Processor confirmed a rounding defect on their side; ticket PS-1234.")
        assertEquals(200, ok.response.status)
        assertEquals("ACKNOWLEDGED", json(ok)["status"].asText())
        assertEquals("it-investigator", json(ok)["acknowledgedBy"].asText())
        assertEquals(409, ack(investigator, "second explanation attempt here").response.status)

        assertEquals(
            ledgerBefore,
            count("SELECT COUNT(*) FROM ledger_entries") to
                jdbc.sql("SELECT COALESCE(SUM(amount),0)::text FROM ledger_entries").query(String::class.java).single(),
        )
        assertEquals(
            paymentsBefore,
            jdbc
                .sql(
                    "SELECT string_agg(id::text || status || amount::text, ',' ORDER BY id) FROM payments",
                ).query(String::class.java)
                .single(),
        )
        assertEquals(1, json(getJson("/api/v1/reconciliations/$run/discrepancies?status=ACKNOWLEDGED"))["totalItems"].asInt())
    }

    @Test
    fun `a discrepancy can only exist once per run, enforced by the database`() {
        seedLines(5)
        val run = UUID.fromString(json(startRun(scenario = "WITH_DISCREPANCIES"))["id"].asText())
        val row =
            jdbc
                .sql(
                    "SELECT type, payment_reference, operation FROM reconciliation_discrepancies WHERE run_id = :r LIMIT 1",
                ).param("r", run)
                .query {
                        rs,
                        _,
                    ->
                    Triple(rs.getString(1), rs.getString(2), rs.getString(3))
                }.single()
        assertFailsWith<Exception> {
            jdbc
                .sql(
                    "INSERT INTO reconciliation_discrepancies (id, run_id, type, payment_reference, operation, created_at) VALUES (gen_random_uuid(), :r, :t, :p, :o, now())",
                ).param("r", run)
                .param("t", row.first)
                .param("p", row.second)
                .param("o", row.third)
                .update()
        }
    }

    @Test
    fun `re-running reconciliation is repeatable and keeps history`() {
        seedLines()
        val first = json(startRun())
        val second = json(startRun())
        assertEquals(first["matchedCount"].asInt(), second["matchedCount"].asInt())
        assertEquals(2, json(getJson("/api/v1/reconciliations"))["totalItems"].asInt())
        assertEquals(2, count("SELECT COUNT(DISTINCT report_id) FROM processor_settlement_records"))
    }

    @Test
    fun `reconciliation is role protected and validates its input`() {
        assertEquals(403, startRun(token = viewer).response.status)
        assertEquals(400, startRun(processor = "NOPE").response.status)
        val bad =
            mvc
                .perform(
                    post(
                        "/api/v1/reconciliations",
                    ).auth(
                        investigator,
                    ).contentType(
                        MediaType.APPLICATION_JSON,
                    ).content("""{"processor":"MOCK_PROCESSOR","from":"2020-01-01T00:00:00Z","to":"2026-01-01T00:00:00Z"}"""),
                ).andReturn()
        assertEquals(400, bad.response.status, "date range is bounded")
    }

    @Test
    fun `processors are reconciled independently`() {
        capture("10.00", processor = "MOCK_PROCESSOR")
        capture("20.00", processor = "MOCK_PROCESSOR_EU")
        assertEquals(1, json(startRun("MOCK_PROCESSOR"))["reportCount"].asInt())
        assertEquals(1, json(startRun("MOCK_PROCESSOR_EU"))["reportCount"].asInt())
    }
}
