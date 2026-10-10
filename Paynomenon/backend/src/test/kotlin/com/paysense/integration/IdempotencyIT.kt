package com.paysense.integration

import org.junit.jupiter.api.Test
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class IdempotencyIT : IntegrationTestBase() {
    @Test
    fun `the same key and payload replays the original response without creating a second payment`() {
        val first = createPayment(key = "key-replay-1")
        val second = createPayment(key = "key-replay-1")
        assertEquals(201, first.response.status)
        assertEquals(201, second.response.status)
        assertEquals(json(first)["id"].asText(), json(second)["id"].asText())
        assertEquals("true", second.response.getHeader("Idempotent-Replayed"))
        assertEquals(null, first.response.getHeader("Idempotent-Replayed"))
        assertEquals(1, count("SELECT COUNT(*) FROM payments"))
        assertEquals(1, count("SELECT COUNT(*) FROM outbox_events WHERE event_type = 'PaymentCreated'"))
    }

    @Test
    fun `an equivalent payload with different number formatting is still the same request`() {
        val a = createPayment(paymentBody("10.5"), key = "key-format")
        val b = createPayment(paymentBody("10.50"), key = "key-format")
        assertEquals(json(a)["id"].asText(), json(b)["id"].asText())
    }

    @Test
    fun `reusing a key with a different payload is a 422 conflict and creates nothing`() {
        createPayment(paymentBody("10.00"), key = "key-conflict")
        val r = createPayment(paymentBody("11.00"), key = "key-conflict")
        assertEquals(422, r.response.status)
        assertEquals("IDEMPOTENCY_KEY_REUSED", json(r)["code"].asText())
        assertEquals(1, count("SELECT COUNT(*) FROM payments"))
    }

    @Test
    fun `keys are scoped per principal`() {
        val a = createPayment(key = "shared-key", token = investigator)
        val b = createPayment(key = "shared-key", token = admin)
        assertNotEquals(json(a)["id"].asText(), json(b)["id"].asText())
        assertEquals(2, count("SELECT COUNT(*) FROM payments"))
    }

    @Test
    fun `malformed keys are rejected`() {
        assertEquals(400, createPayment(key = "has space").response.status)
        assertEquals(400, createPayment(key = "k".repeat(300)).response.status)
        assertEquals(0, count("SELECT COUNT(*) FROM payments"))
    }

    @Test
    fun `requests without a key are independent`() {
        createPayment()
        createPayment()
        assertEquals(2, count("SELECT COUNT(*) FROM payments"))
        assertEquals(0, count("SELECT COUNT(*) FROM idempotency_records"))
    }

    @Test
    fun `50 concurrent requests with one key create exactly one payment`() {
        val threads = 50
        val pool = Executors.newFixedThreadPool(threads)
        val start = CountDownLatch(1)
        val futures =
            (1..threads).map {
                pool.submit<Pair<Int, String?>> {
                    start.await()
                    val r = createPayment(paymentBody("77.77"), key = "key-concurrent")
                    r.response.status to runCatching { json(r)["id"].asText() }.getOrNull()
                }
            }
        start.countDown()
        val results = futures.map { it.get(60, TimeUnit.SECONDS) }
        pool.shutdown()
        assertTrue(
            results.all {
                it.first == 201
            },
            "every concurrent duplicate must see the same successful response, got ${results.map {
                it.first
            }.groupingBy { it }.eachCount()}",
        )
        assertEquals(1, results.map { it.second }.toSet().size, "all responses must reference the same payment")
        assertEquals(1, count("SELECT COUNT(*) FROM payments"))
        assertEquals(1, count("SELECT COUNT(*) FROM outbox_events WHERE event_type = 'PaymentCreated'"))
        assertEquals(1, count("SELECT COUNT(*) FROM idempotency_records WHERE status = 'COMPLETED'"))
    }

    @Test
    fun `concurrent requests with different keys do not interfere`() {
        val pool = Executors.newFixedThreadPool(10)
        val futures = (1..30).map { i -> pool.submit<Int> { createPayment(paymentBody("5.00"), key = "key-many-$i").response.status } }
        assertTrue(futures.all { it.get(60, TimeUnit.SECONDS) == 201 })
        pool.shutdown()
        assertEquals(30, count("SELECT COUNT(*) FROM payments"))
    }

    @Test
    fun `an operation replays its stored response, and a second authorize is not sent to the processor`() {
        val id = newPaymentId()
        val first = operate(id, "authorize", key = "auth-key-1")
        val replay = operate(id, "authorize", key = "auth-key-1")
        assertEquals(200, first.response.status)
        assertEquals(200, replay.response.status)
        assertEquals("true", replay.response.getHeader("Idempotent-Replayed"))
        assertEquals("AUTHORIZED", json(replay)["status"].asText())
        assertEquals(1, count("SELECT COUNT(*) FROM payment_attempts WHERE payment_id = '$id'"), "no second processor call")
        assertEquals(1, count("SELECT COUNT(*) FROM mock_processor_transactions"))
        // same key on a different operation is a conflict, not a replay
        val other = operate(id, "capture", key = "auth-key-1")
        assertEquals(422, other.response.status)
    }

    @Test
    fun `concurrent duplicate captures execute the processor call once`() {
        val id = newPaymentId()
        operate(id, "authorize")
        val pool = Executors.newFixedThreadPool(8)
        val start = CountDownLatch(1)
        val futures =
            (1..8).map {
                pool.submit<Int> {
                    start.await()
                    operate(id, "capture", key = "capture-key").response.status
                }
            }
        start.countDown()
        val statuses = futures.map { it.get(60, TimeUnit.SECONDS) }
        pool.shutdown()
        assertTrue(
            statuses.all { it == 200 || it == 409 },
            "duplicates are replayed (200) or told the original is in progress (409): $statuses",
        )
        assertTrue(statuses.any { it == 200 })
        assertEquals("CAPTURED", status(id))
        assertEquals(1, count("SELECT COUNT(*) FROM ledger_transactions WHERE payment_id = '$id' AND operation = 'CAPTURE'"))
        assertEquals(1, count("SELECT COUNT(*) FROM payment_attempts WHERE payment_id = '$id' AND operation = 'CAPTURE'"))
    }

    @Test
    fun `without keys, concurrent captures are serialized by the row lock and only one wins`() {
        val id = newPaymentId()
        operate(id, "authorize")
        val pool = Executors.newFixedThreadPool(8)
        val start = CountDownLatch(1)
        val futures =
            (1..8).map {
                pool.submit<Int> {
                    start.await()
                    operate(id, "capture").response.status
                }
            }
        start.countDown()
        val statuses = futures.map { it.get(60, TimeUnit.SECONDS) }
        pool.shutdown()
        assertEquals(1, statuses.count { it == 200 }, "exactly one capture succeeds: $statuses")
        assertTrue(statuses.filter { it != 200 }.all { it == 409 })
        assertEquals(1, count("SELECT COUNT(*) FROM ledger_transactions WHERE payment_id = '$id'"))
    }

    @Test
    fun `a transient processor outage is not stored, so the same key can be retried after recovery`() {
        val id = newPaymentId()
        simulation.forceNext("MOCK_PROCESSOR", com.paysense.processors.SimOutcome.UNAVAILABLE, 3)
        val failed = operate(id, "authorize", key = "outage-key")
        assertEquals(503, failed.response.status)
        assertEquals("PROCESSOR_UNAVAILABLE", json(failed)["code"].asText())
        assertEquals("CREATED", status(id), "never reached the processor: safe to retry")
        assertEquals(0, count("SELECT COUNT(*) FROM idempotency_records"), "failed attempt must release the key")
        val retried = operate(id, "authorize", key = "outage-key")
        assertEquals(200, retried.response.status)
        assertEquals("AUTHORIZED", json(retried)["status"].asText())
        assertEquals(
            2,
            count("SELECT COUNT(*) FROM payment_attempts WHERE payment_id = '$id'"),
            "failed + successful attempt are both on record",
        )
    }

    @Test
    fun `a processor decline IS stored and replayed, because it is a deterministic outcome`() {
        val id = newPaymentId(paymentBody(description = "[sim:insufficient_funds]"))
        val first = operate(id, "authorize", key = "decline-key")
        val replay = operate(id, "authorize", key = "decline-key")
        assertEquals("FAILED", json(first)["status"].asText())
        assertEquals("true", replay.response.getHeader("Idempotent-Replayed"))
        assertEquals("FAILED", json(replay)["status"].asText())
    }

    @Test
    fun `an abandoned in-progress record can be taken over after the timeout`() {
        val id = newPaymentId()
        // simulate a crashed request: a committed IN_PROGRESS record that never completed, last touched long ago
        val body = "authorize"
        val fp =
            com.paysense.idempotency.IdempotencyKeys
                .fingerprint("POST /payments/$id/authorize", null)
        jdbc
            .sql(
                "INSERT INTO idempotency_records (id, principal, idempotency_key, operation, request_fingerprint, status, created_at, updated_at, expires_at) VALUES (:id, 'it-investigator', 'stale-key', :op, :fp, 'IN_PROGRESS', now() - interval '10 minutes', now() - interval '10 minutes', now() + interval '1 day')",
            ).param("id", UUID.randomUUID())
            .param("op", "POST /payments/$id/$body")
            .param("fp", fp)
            .update()
        val r = operate(id, "authorize", key = "stale-key")
        assertEquals(200, r.response.status)
        assertEquals(
            "COMPLETED",
            jdbc.sql("SELECT status FROM idempotency_records WHERE idempotency_key = 'stale-key'").query(String::class.java).single(),
        )
    }

    @Test
    fun `a fresh in-progress record makes duplicates wait with 409 and Retry-After`() {
        val id = newPaymentId()
        val fp =
            com.paysense.idempotency.IdempotencyKeys
                .fingerprint("POST /payments/$id/authorize", null)
        jdbc
            .sql(
                "INSERT INTO idempotency_records (id, principal, idempotency_key, operation, request_fingerprint, status, created_at, updated_at, expires_at) VALUES (:id, 'it-investigator', 'busy-key', :op, :fp, 'IN_PROGRESS', now(), now(), now() + interval '1 day')",
            ).param("id", UUID.randomUUID())
            .param("op", "POST /payments/$id/authorize")
            .param("fp", fp)
            .update()
        val r = operate(id, "authorize", key = "busy-key")
        assertEquals(409, r.response.status)
        assertEquals("IDEMPOTENCY_REQUEST_IN_PROGRESS", json(r)["code"].asText())
        assertEquals("1", r.response.getHeader("Retry-After"))
        assertEquals("CREATED", status(id), "the duplicate must not have executed anything")
    }

    @Test
    fun `expired idempotency records are purged`() {
        createPayment(key = "old-key")
        jdbc.sql("UPDATE idempotency_records SET expires_at = now() - interval '1 hour'").update()
        val purged = idempotencyService.purgeExpired(java.time.Instant.now())
        assertEquals(1, purged)
        assertEquals(0, count("SELECT COUNT(*) FROM idempotency_records"))
    }

    @org.springframework.beans.factory.annotation.Autowired
    private lateinit var idempotencyService: com.paysense.idempotency.IdempotencyService
}
