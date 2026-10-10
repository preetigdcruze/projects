package com.paysense.integration

import com.ninjasquad.springmockk.SpykBean
import com.paysense.events.OutboxPublisher
import com.paysense.events.OutboxWriter
import com.paysense.payments.StuckPaymentRecovery
import io.mockk.every
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Proves business changes and their outbox events are atomic: if one cannot be written, neither is. */
class TransactionRollbackIT : IntegrationTestBase() {
    @SpykBean lateinit var outbox: OutboxWriter

    @Autowired lateinit var publisher: OutboxPublisher

    @Autowired lateinit var recovery: StuckPaymentRecovery

    @AfterEach
    fun heal() {
        every { outbox.append(any(), any(), any(), any(), any()) } answers { callOriginal() }
    }

    private fun breakOutbox() {
        every { outbox.append(any(), any(), any(), any(), any()) } throws
            RuntimeException("outbox table unavailable (test)")
    }

    @Test
    fun `if the outbox write fails, payment creation rolls back completely including its idempotency record`() {
        breakOutbox()
        val r = createPayment(key = "rollback-key")
        assertEquals(500, r.response.status)
        assertEquals("INTERNAL_ERROR", json(r)["code"].asText())
        assertTrue(!r.response.contentAsString.contains("outbox"), "internal details must not leak")
        assertEquals(0, count("SELECT COUNT(*) FROM payments"))
        assertEquals(0, count("SELECT COUNT(*) FROM payment_events"))
        assertEquals(0, count("SELECT COUNT(*) FROM idempotency_records"))
        heal()
        assertEquals(201, createPayment(key = "rollback-key").response.status, "the key was not consumed by the failed attempt")
        assertEquals(1, count("SELECT COUNT(*) FROM payments"))
    }

    @Test
    fun `a failure after the processor executed leaves an in-flight payment that reconciliation repairs without a second charge`() {
        val id = newPaymentId()
        breakOutbox() // the processor call succeeds, but recording the result (state + ledger + outbox) fails and rolls back
        val r = operate(id, "authorize")
        assertEquals(500, r.response.status)
        assertEquals("PROCESSING", status(id), "result transaction rolled back as a unit")
        assertEquals(1, count("SELECT COUNT(*) FROM mock_processor_transactions"), "but the processor really executed it")
        heal()

        jdbc.sql("UPDATE payments SET updated_at = now() - interval '10 minutes' WHERE id = :id").param("id", id).update()
        assertEquals(1, recovery.sweep())
        while (publisher.publishBatch() > 0) { /* drain: ProcessorTimeout -> resolver */ }
        assertEquals("AUTHORIZED", status(id))
        assertEquals(1, count("SELECT COUNT(*) FROM mock_processor_transactions"), "never charged twice")
    }

    @Test
    fun `a capture whose result cannot be recorded books no ledger entries`() {
        val id = newPaymentId()
        operate(id, "authorize")
        breakOutbox()
        assertEquals(500, operate(id, "capture").response.status)
        assertEquals(0, count("SELECT COUNT(*) FROM ledger_transactions"))
        assertEquals(0, count("SELECT COUNT(*) FROM ledger_entries"))
        assertEquals("CAPTURING", status(id))
    }
}
