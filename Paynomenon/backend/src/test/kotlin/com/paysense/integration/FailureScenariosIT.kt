package com.paysense.integration

import com.paysense.events.OutboxPublisher
import com.paysense.payments.PaymentOperation
import com.paysense.payments.PaymentOperationService
import com.paysense.payments.StuckPaymentRecovery
import com.paysense.payments.UncertainPaymentResolver
import com.paysense.processors.SimOutcome
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class FailureScenariosIT : IntegrationTestBase() {
    @Autowired lateinit var publisher: OutboxPublisher

    @Autowired lateinit var resolver: UncertainPaymentResolver

    @Autowired lateinit var recovery: StuckPaymentRecovery

    @Autowired lateinit var operations: PaymentOperationService

    private fun drainOutbox() {
        repeat(20) { if (publisher.publishBatch() == 0) return }
    }

    // ---- ambiguous processor outcomes ------------------------------------------------------------------------

    @Test
    fun `a timeout where the processor DID execute is recorded as UNCERTAIN, never retried, then resolved by lookup`() {
        val id = newPaymentId()
        simulation.forceNext("MOCK_PROCESSOR", SimOutcome.TIMEOUT_EXECUTED, 1)
        val r = operate(id, "authorize")
        assertEquals(202, r.response.status, "uncertain outcomes are accepted, not reported as failures")
        assertEquals("UNCERTAIN", json(r)["status"].asText())
        assertEquals("AUTHORIZE", json(r)["pendingOperation"].asText())
        assertEquals("TIMEOUT", json(r)["attempts"][0]["status"].asText())
        assertEquals(1, count("SELECT COUNT(*) FROM mock_processor_transactions"), "the processor executed it exactly once")
        assertEquals(1, count("SELECT COUNT(*) FROM outbox_events WHERE event_type = 'ProcessorTimeout'"))
        assertEquals(1, count("SELECT COUNT(*) FROM payment_attempts"), "no blind retry of an ambiguous call")

        // while uncertain, the client cannot start another operation (it could double charge)
        val blocked = operate(id, "authorize")
        assertEquals(409, blocked.response.status)
        assertEquals("PAYMENT_OUTCOME_UNCERTAIN", json(blocked)["code"].asText())

        drainOutbox() // ProcessorTimeout -> uncertain-payment-resolver consumer -> processor lookup
        assertEquals("AUTHORIZED", status(id))
        assertEquals(1, count("SELECT COUNT(*) FROM mock_processor_transactions"), "reconciliation must not re-send the charge")
        val events = json(getJson("/api/v1/payments/$id/events"))["items"].map { it["eventType"].asText() }
        assertTrue("OUTCOME_UNCERTAIN" in events && "OUTCOME_RESOLVED" in events, events.toString())
        assertEquals(1, count("SELECT COUNT(*) FROM processed_events WHERE consumer = 'uncertain-payment-resolver'"))
    }

    @Test
    fun `a timeout where the processor never executed resolves back to CREATED so the client can try again`() {
        val id = newPaymentId()
        simulation.forceNext("MOCK_PROCESSOR", SimOutcome.TIMEOUT_NOT_EXECUTED, 1)
        assertEquals("UNCERTAIN", json(operate(id, "authorize"))["status"].asText())
        drainOutbox()
        assertEquals("CREATED", status(id))
        assertEquals(0, count("SELECT COUNT(*) FROM mock_processor_transactions"))
        assertEquals("AUTHORIZED", json(operate(id, "authorize"))["status"].asText())
    }

    @Test
    fun `an uncertain capture resolves to CAPTURED with exactly one ledger posting`() {
        val id = newPaymentId()
        operate(id, "authorize")
        simulation.forceNext("MOCK_PROCESSOR", SimOutcome.TIMEOUT_EXECUTED, 1)
        assertEquals("UNCERTAIN", json(operate(id, "capture"))["status"].asText())
        assertEquals(0, count("SELECT COUNT(*) FROM ledger_transactions"), "no money is booked while the outcome is unknown")
        drainOutbox()
        assertEquals("CAPTURED", status(id))
        assertEquals(1, count("SELECT COUNT(*) FROM ledger_transactions WHERE payment_id = '$id'"))
        resolver.resolve(id, "TEST", "test", "corr-resolve-twice") // resolving again is harmless
        assertEquals(1, count("SELECT COUNT(*) FROM ledger_transactions WHERE payment_id = '$id'"))
    }

    @Test
    fun `a slow processor beyond the client deadline is treated as an ambiguous timeout`() {
        val id = newPaymentId()
        simulation.realDelay = true
        try {
            simulation.update("MOCK_PROCESSOR", com.paysense.processors.SimulationSettings(delayedRate = 1.0, delayMs = 5000))
            val r = operate(id, "authorize")
            assertEquals(202, r.response.status)
            assertEquals("UNCERTAIN", json(r)["status"].asText())
        } finally {
            simulation.realDelay = false
        }
        simulation.reset()
        drainOutbox()
        assertEquals("AUTHORIZED", status(id), "the processor had executed it before the client gave up waiting")
    }

    // ---- outages, retries, circuit breaker ----------------------------------------------------------------------

    @Test
    fun `transient unavailability is retried with the same request id and succeeds`() {
        val id = newPaymentId()
        simulation.forceNext("MOCK_PROCESSOR", SimOutcome.UNAVAILABLE, 2) // fails twice, third try (max 3) succeeds
        val r = operate(id, "authorize")
        assertEquals(200, r.response.status)
        assertEquals("AUTHORIZED", json(r)["status"].asText())
        assertEquals(1, count("SELECT COUNT(*) FROM payment_attempts"))
        assertEquals(2, count("SELECT COUNT(*) FROM operational_logs WHERE component = 'processor-client' AND message LIKE 'Retrying%'"))
    }

    @Test
    fun `permanent errors are not retried`() {
        val id = newPaymentId()
        simulation.forceNext("MOCK_PROCESSOR", SimOutcome.INVALID_REQUEST, 1)
        val r = operate(id, "authorize")
        assertEquals("FAILED", json(r)["status"].asText())
        assertEquals("INVALID_REQUEST", json(r)["failureCategory"].asText())
        assertEquals(0, count("SELECT COUNT(*) FROM operational_logs WHERE message LIKE 'Retrying%'"))
    }

    @Test
    fun `repeated failures open the circuit, calls are rejected without reaching the processor, and it recovers`() {
        simulation.forceNext("MOCK_PROCESSOR", SimOutcome.UNAVAILABLE, 100)
        val ids = (1..4).map { newPaymentId() }
        ids.forEach { assertEquals(503, operate(it, "authorize").response.status) }
        assertEquals("OPEN", processorClient.circuitState("MOCK_PROCESSOR").name)

        val remainingBefore = simulation.status(listOf("MOCK_PROCESSOR")).forcedQueued["MOCK_PROCESSOR"]
        val rejected = operate(newPaymentId(), "authorize")
        assertEquals(503, rejected.response.status)
        assertEquals(
            remainingBefore,
            simulation.status(listOf("MOCK_PROCESSOR")).forcedQueued["MOCK_PROCESSOR"],
            "an open circuit must not call the processor",
        )
        assertEquals("MOCK_PROCESSOR_EU", "MOCK_PROCESSOR_EU")
        assertEquals(
            "AUTHORIZED",
            json(
                operate(
                    newPaymentId(paymentBody(processor = "MOCK_PROCESSOR_EU")).also {
                    },
                    "authorize",
                ),
            )["status"].asText(),
            "other processors are unaffected",
        )

        simulation.reset() // the processor recovers
        Thread.sleep(1200) // open-duration is 1s in the test profile
        val probe1 = operate(newPaymentId(), "authorize")
        val probe2 = operate(newPaymentId(), "authorize")
        assertEquals(200, probe1.response.status)
        assertEquals(200, probe2.response.status)
        assertEquals("CLOSED", processorClient.circuitState("MOCK_PROCESSOR").name)
        assertTrue(count("SELECT COUNT(*) FROM operational_logs WHERE component = 'circuit-breaker'") >= 3)
    }

    // ---- crashes ---------------------------------------------------------------------------------------------------

    @Test
    fun `a worker that died mid-operation leaves a stuck payment that recovery turns into UNCERTAIN and reconciles`() {
        val id = newPaymentId()
        operations.beginOnly(id, PaymentOperation.AUTHORIZE, "test", "corr-crash-0001")
        assertEquals("PROCESSING", status(id))
        assertEquals(0, recovery.sweep(), "a fresh in-flight payment is not stuck yet")
        jdbc.sql("UPDATE payments SET updated_at = now() - interval '10 minutes' WHERE id = :id").param("id", id).update()
        assertEquals(1, recovery.sweep())
        assertEquals("UNCERTAIN", status(id))
        drainOutbox()
        assertEquals("CREATED", status(id), "processor has no record: the operation never ran, so it can be attempted again")
        assertEquals("AUTHORIZED", json(operate(id, "authorize"))["status"].asText())
    }

    @Test
    fun `a worker that died AFTER the processor executed is reconciled to the processor's truth`() {
        val id = newPaymentId()
        val attempt = operations.beginOnly(id, PaymentOperation.AUTHORIZE, "test", "corr-crash-0002")
        jdbc
            .sql(
                "INSERT INTO mock_processor_transactions (id, processor, request_id, operation, payment_reference, amount, currency, status, response_code, executed_at) VALUES (gen_random_uuid(), 'MOCK_PROCESSOR', :r, 'AUTHORIZE', :p, 49.99, 'EUR', 'APPROVED', 'APPROVED', now())",
            ).param("r", attempt.processorRequestId)
            .param("p", id.toString())
            .update()
        jdbc.sql("UPDATE payments SET updated_at = now() - interval '10 minutes' WHERE id = :id").param("id", id).update()
        recovery.sweep()
        drainOutbox()
        assertEquals("AUTHORIZED", status(id))
        assertEquals(1, count("SELECT COUNT(*) FROM mock_processor_transactions"))
    }

    // ---- duplicate callbacks ------------------------------------------------------------------------------------

    private fun signed(body: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec("dev-callback-secret".toByteArray(), "HmacSHA256"))
        return mac.doFinal(body.toByteArray()).joinToString("") { "%02x".format(it) }
    }

    private fun callback(
        id: UUID,
        callbackId: String = "cb-1",
        result: String = "APPROVED",
        op: String = "AUTHORIZE",
        sign: Boolean = true,
    ) =
        """{"processor":"MOCK_PROCESSOR","callbackId":"$callbackId","paymentId":"$id","operation":"$op","result":"$result","responseCode":"$result"}"""
            .let { body ->
                mvc
                    .perform(
                        post("/api/v1/processors/callbacks").contentType(MediaType.APPLICATION_JSON).content(body).also { b ->
                            if (sign) b.header("X-Signature", signed(body))
                        },
                    ).andReturn()
            }

    @Test
    fun `a processor callback resolves an uncertain payment and a duplicate delivery is a harmless no-op`() {
        val id = newPaymentId()
        simulation.forceNext("MOCK_PROCESSOR", SimOutcome.TIMEOUT_EXECUTED, 1)
        operate(id, "authorize")
        val first = callback(id)
        assertEquals(200, first.response.status)
        assertEquals(true, json(first)["applied"].asBoolean())
        assertEquals("AUTHORIZED", status(id))
        val eventsAfterFirst = count("SELECT COUNT(*) FROM payment_events WHERE payment_id = '$id'")
        val dup = callback(id)
        assertEquals(true, json(dup)["duplicate"].asBoolean())
        assertEquals(false, json(dup)["applied"].asBoolean())
        assertEquals(
            eventsAfterFirst,
            count("SELECT COUNT(*) FROM payment_events WHERE payment_id = '$id'"),
            "duplicate must not add history",
        )
        assertEquals(1, count("SELECT COUNT(*) FROM processor_callbacks"))
        // the ProcessorTimeout consumer arriving later finds nothing left to resolve
        drainOutbox()
        assertEquals("AUTHORIZED", status(id))
    }

    @Test
    fun `callbacks need a valid signature and cannot change a payment that is not uncertain`() {
        val id = newPaymentId()
        operate(id, "authorize")
        assertEquals(401, callback(id, "cb-unsigned", sign = false).response.status)
        assertEquals(0, count("SELECT COUNT(*) FROM processor_callbacks"))
        val r = callback(id, "cb-declined", result = "DECLINED")
        assertEquals(false, json(r)["applied"].asBoolean())
        assertEquals("AUTHORIZED", status(id), "a callback must not overwrite a settled state")
    }

    @Test
    fun `the simulated duplicate-callback outcome produces exactly one effective callback`() {
        val id = newPaymentId()
        simulation.forceNext("MOCK_PROCESSOR", SimOutcome.DUPLICATE_CALLBACK, 1)
        assertEquals("AUTHORIZED", json(operate(id, "authorize"))["status"].asText())
        assertEquals(1, count("SELECT COUNT(*) FROM processor_callbacks"))
        assertEquals(1, count("SELECT COUNT(*) FROM payment_events WHERE payment_id = '$id' AND event_type = 'CALLBACK_RECEIVED'"))
    }

    // ---- infrastructure failures ---------------------------------------------------------------------------------

    @Test
    fun `database failure during payment creation leaves no partial state and the key stays usable`() {
        jdbc.sql("ALTER TABLE payment_events RENAME TO payment_events_offline").update()
        val failed =
            try {
                createPayment(key = "db-down-key")
            } finally {
                jdbc.sql("ALTER TABLE payment_events_offline RENAME TO payment_events").update()
            }
        assertEquals(503, failed.response.status)
        assertEquals("DATABASE_UNAVAILABLE", json(failed)["code"].asText())
        assertTrue(failed.response.getHeader("Retry-After") != null)
        assertTrue(!failed.response.contentAsString.contains("payment_events"), "internals must not leak")
        assertEquals(0, count("SELECT COUNT(*) FROM payments"), "the payment insert must have rolled back")
        assertEquals(0, count("SELECT COUNT(*) FROM outbox_events"))
        assertEquals(0, count("SELECT COUNT(*) FROM idempotency_records"))
        val retry = createPayment(key = "db-down-key")
        assertEquals(201, retry.response.status)
        assertEquals(1, count("SELECT COUNT(*) FROM payments"))
    }

    @Test
    fun `severed database connections are recovered by the pool`() {
        newPaymentId()
        jdbc
            .sql(
                "SELECT COUNT(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND application_name <> 'psql'",
            ).query(Long::class.java)
            .single()
        // the first request after the kill may fail on a dead connection; the pool must then self-heal
        val attempts = (1..5).map { createPayment().response.status }
        assertTrue(attempts.last() == 201, "pool did not recover: $attempts")
    }

    @Test
    fun `the AI service being down never affects payment processing and is reported explicitly`() {
        val id = newPaymentId()
        operate(id, "authorize")
        val inv =
            mvc
                .perform(
                    post(
                        "/api/v1/ai/investigations",
                    ).auth(
                        investigator,
                    ).contentType(
                        MediaType.APPLICATION_JSON,
                    ).content("""{"subjectType":"PAYMENT","subjectId":"$id","question":"Why is this payment in this state?"}"""),
                ).andReturn()
        assertEquals(201, inv.response.status)
        assertEquals("UNAVAILABLE", json(inv)["status"].asText())
        assertTrue(json(inv)["errorCategory"].asText() in setOf("UNREACHABLE", "TIMEOUT"))
        assertTrue(!json(inv).has("result") || json(inv)["result"].isNull, "no AI answer may be fabricated")
        val persisted = json(getJson("/api/v1/ai/investigations/${json(inv)["id"].asText()}"))
        assertEquals("UNAVAILABLE", persisted["status"].asText())

        val analytics =
            mvc
                .perform(
                    post(
                        "/api/v1/ai/analytics-queries",
                    ).auth(
                        viewer,
                    ).contentType(MediaType.APPLICATION_JSON)
                        .content("""{"question":"Which processor has the highest failure rate today?"}"""),
                ).andReturn()
        assertEquals("UNAVAILABLE", json(analytics)["status"].asText())
        assertEquals("UNAVAILABLE", json(getJson("/api/v1/ai/provider-status"))["status"].asText())
        assertEquals(200, getJson("/api/v1/analytics/overview").response.status, "non-AI analytics keeps working")
        assertEquals("CAPTURED", json(operate(id, "capture"))["status"].asText())
        val health = json(getJson("/api/v1/system/status"))
        assertEquals("DOWN", health["ai"]["status"].asText())
        assertEquals("UP", health["database"]["status"].asText())
    }

    @Test
    fun `investigations of unknown subjects are rejected and the endpoint is role protected`() {
        val body = """{"subjectType":"PAYMENT","subjectId":"${UUID.randomUUID()}","question":"why?? please explain"}"""
        assertEquals(
            404,
            mvc
                .perform(
                    post("/api/v1/ai/investigations").auth(investigator).contentType(MediaType.APPLICATION_JSON).content(body),
                ).andReturn()
                .response.status,
        )
        assertEquals(
            403,
            mvc
                .perform(
                    post("/api/v1/ai/investigations").auth(viewer).contentType(MediaType.APPLICATION_JSON).content(body),
                ).andReturn()
                .response.status,
        )
        assertEquals(
            400,
            mvc
                .perform(
                    post(
                        "/api/v1/ai/investigations",
                    ).auth(investigator).contentType(MediaType.APPLICATION_JSON).content("""{"subjectType":"PAYMENT"}"""),
                ).andReturn()
                .response.status,
        )
        assertEquals(
            200,
            mvc
                .perform(get("/api/v1/ai/investigations").auth(viewer))
                .andReturn()
                .response.status,
        )
    }
}
