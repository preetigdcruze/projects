package com.paysense.integration

import com.paysense.events.DomainEventType
import com.paysense.events.EventDispatcher
import com.paysense.events.EventEnvelope
import com.paysense.events.OutboxPublisher
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import java.time.Instant
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class OutboxAndConsumersIT : IntegrationTestBase() {
    @Autowired lateinit var publisher: OutboxPublisher

    @Autowired lateinit var dispatcher: EventDispatcher

    private fun testEvent(id: UUID = UUID.randomUUID()) =
        EventEnvelope(
            id,
            "TestEvent",
            1,
            "test",
            UUID.randomUUID(),
            Instant.now(),
            "corr-test-0001",
            mapOf("k" to "v"),
        )

    private fun sideEffects(eventId: UUID) = count("SELECT COUNT(*) FROM operational_logs WHERE message = 'effect:$eventId'")

    // ---- outbox publisher -------------------------------------------------------------------------------------

    @Test
    fun `the business change and its outbox event are committed together and published in order`() {
        val id = newPaymentId()
        operate(id, "authorize")
        operate(id, "capture")
        assertEquals(3, count("SELECT COUNT(*) FROM outbox_events WHERE status = 'PENDING'"))
        assertEquals(3, publisher.publishBatch())
        assertEquals(listOf("PaymentCreated", "PaymentAuthorized", "PaymentCaptured"), transport.sent.map { it.eventType })
        assertEquals(3, count("SELECT COUNT(*) FROM outbox_events WHERE status = 'PUBLISHED' AND published_at IS NOT NULL"))
        assertEquals(0, publisher.publishBatch(), "nothing is published twice in the normal case")
        val e = transport.sent.first()
        assertEquals(1, e.schemaVersion)
        assertEquals("payment", e.aggregateType)
        assertEquals(id, e.aggregateId)
        assertTrue(e.correlationId.isNotBlank())
        assertNotNull(e.eventId)
    }

    @Test
    fun `broker outage never fails the business operation, events wait in the outbox and are published after recovery`() {
        transport.failing.set(true)
        val id = newPaymentId()
        assertEquals("AUTHORIZED", json(operate(id, "authorize"))["status"].asText(), "payments keep working while the broker is down")
        assertEquals(0, publisher.publishBatch())
        val row =
            jdbc
                .sql(
                    "SELECT attempts, status, last_error, next_attempt_at > created_at AS backed_off FROM outbox_events WHERE event_type = 'PaymentCreated'",
                ).query {
                        rs,
                        _,
                    ->
                    listOf(rs.getInt(1), rs.getString(2), rs.getString(3), rs.getBoolean(4))
                }.single()
        assertEquals(1, row[0])
        assertEquals("PENDING", row[1])
        assertTrue((row[2] as String).contains("broker unavailable"))
        assertEquals(true, row[3], "retry must be delayed (backoff)")
        // ordering: the later event of the same payment must not overtake the one that is backing off
        assertEquals(0, count("SELECT COUNT(*) FROM outbox_events WHERE status = 'PUBLISHED'"))

        transport.failing.set(false)
        Thread.sleep(150) // backoff in the test profile is 10-50ms
        assertEquals(2, publisher.publishBatch())
        assertEquals(listOf("PaymentCreated", "PaymentAuthorized"), transport.sent.map { it.eventType })
    }

    @Test
    fun `an event that keeps failing is parked as FAILED after the retry budget and can be requeued by an admin`() {
        transport.failing.set(true)
        newPaymentId()
        repeat(6) {
            publisher.publishBatch()
            Thread.sleep(80)
        }
        assertEquals("FAILED", jdbc.sql("SELECT status FROM outbox_events").query(String::class.java).single())
        assertEquals(4, count("SELECT attempts FROM outbox_events"))
        assertEquals(1, count("SELECT COUNT(*) FROM operational_logs WHERE component = 'outbox' AND level = 'ERROR'"))
        assertEquals(
            403,
            mvc
                .perform(post("/api/v1/admin/events/outbox/requeue-failed").auth(investigator))
                .andReturn()
                .response.status,
        )
        transport.failing.set(false)
        assertEquals(1, json(mvc.perform(post("/api/v1/admin/events/outbox/requeue-failed").auth(admin)).andReturn())["requeued"].asInt())
        assertEquals(1, publisher.publishBatch())
        assertEquals("PUBLISHED", jdbc.sql("SELECT status FROM outbox_events").query(String::class.java).single())
    }

    @Test
    fun `publisher restart safety - events already published are not sent again, unpublished ones are`() {
        newPaymentId()
        newPaymentId()
        assertEquals(2, publisher.publishBatch())
        newPaymentId()
        // a "restarted" publisher is just another call: state lives in the database, not in memory
        assertEquals(1, publisher.publishBatch())
        assertEquals(3, transport.sent.size)
    }

    // ---- consumers: deduplication, retry, dead letters, replay -------------------------------------------------

    @Test
    fun `duplicate delivery of the same event is processed once (consumer idempotency)`() {
        transport.deliverTwice.set(true)
        val paymentId = newPaymentId()
        simulation.forceNext("MOCK_PROCESSOR", com.paysense.processors.SimOutcome.TIMEOUT_EXECUTED, 1)
        operate(paymentId, "authorize")
        publisher.publishBatch()
        assertEquals("AUTHORIZED", status(paymentId))
        assertEquals(1, count("SELECT COUNT(*) FROM payment_events WHERE payment_id = '$paymentId' AND event_type = 'OUTCOME_RESOLVED'"))
        assertEquals(1, count("SELECT COUNT(*) FROM processed_events WHERE consumer = 'uncertain-payment-resolver'"))
    }

    @Test
    fun `the same event dispatched twice runs the handler's side effect once`() {
        val e = testEvent()
        dispatcher.dispatch(e)
        dispatcher.dispatch(e)
        assertEquals(1, sideEffects(e.eventId))
        assertEquals(1, flaky.invocations.get())
        assertEquals(1, count("SELECT COUNT(*) FROM processed_events WHERE consumer = 'flaky-test-handler'"))
    }

    @Test
    fun `transient handler failures are retried with backoff until they succeed`() {
        flaky.remainingFailures.set(2) // max attempts is 3
        val e = testEvent()
        dispatcher.dispatch(e)
        assertEquals(3, flaky.invocations.get())
        assertEquals(1, sideEffects(e.eventId), "failed attempts roll back their side effects")
        assertEquals(0, count("SELECT COUNT(*) FROM dead_letter_events"))
    }

    @Test
    fun `a worker crash after the side effect but before commit does not duplicate or lose the effect`() {
        flaky.crashAfterSideEffect.set(true)
        flaky.remainingFailures.set(1)
        val e = testEvent()
        dispatcher.dispatch(e) // attempt 1 writes then dies, attempt 2 (redelivery) succeeds
        assertEquals(1, sideEffects(e.eventId))
        assertEquals(1, count("SELECT COUNT(*) FROM processed_events WHERE consumer = 'flaky-test-handler' AND event_id = '${e.eventId}'"))
    }

    @Test
    fun `repeated consumer failures end in the dead-letter table with the evidence needed to investigate`() {
        flaky.remainingFailures.set(100)
        val e = testEvent()
        dispatcher.dispatch(e)
        assertEquals(3, flaky.invocations.get(), "bounded retries")
        assertEquals(0, sideEffects(e.eventId))
        val dl =
            jdbc
                .sql("SELECT consumer, event_type, attempts, status, error_class, error_message FROM dead_letter_events")
                .query { rs, _ ->
                    (1..6).map { rs.getString(it) }
                }.single()
        assertEquals(listOf("flaky-test-handler", "TestEvent", "3", "DEAD"), dl.take(4))
        assertTrue(dl[4]!!.contains("IllegalStateException"))
        assertEquals(0, count("SELECT COUNT(*) FROM processed_events WHERE event_id = '${e.eventId}'"))
        assertEquals(
            1,
            count("SELECT COUNT(*) FROM operational_logs WHERE component = 'event-consumer' AND message LIKE '%dead-lettered%'"),
        )
        dispatcher.dispatch(e) // redelivery of the same poison event does not create a second dead letter
        assertEquals(1, count("SELECT COUNT(*) FROM dead_letter_events"))
    }

    @Test
    fun `non-retryable failures are dead-lettered immediately`() {
        flaky.permanent.set(true)
        dispatcher.dispatch(testEvent())
        assertEquals(1, flaky.invocations.get())
        assertEquals("1", jdbc.sql("SELECT attempts FROM dead_letter_events").query(String::class.java).single())
    }

    @Test
    fun `one failing consumer does not block the others`() {
        flaky.remainingFailures.set(100)
        val paymentId = newPaymentId()
        simulation.forceNext("MOCK_PROCESSOR", com.paysense.processors.SimOutcome.TIMEOUT_EXECUTED, 1)
        operate(paymentId, "authorize")
        // a ProcessorTimeout is not handled by the flaky handler; and a failing TestEvent must not affect real events
        dispatcher.dispatch(testEvent())
        publisher.publishBatch()
        assertEquals("AUTHORIZED", status(paymentId))
    }

    @Test
    fun `dead letters can be replayed by an admin once, with a reason, and replay is safe`() {
        flaky.remainingFailures.set(100)
        val e = testEvent()
        dispatcher.dispatch(e)
        val dlId = jdbc.sql("SELECT id FROM dead_letter_events").query(UUID::class.java).single()
        val url = "/api/v1/admin/events/dead-letters/$dlId/replay"

        fun replay(
            token: String,
            reason: String?,
        ) = mvc
            .perform(
                post(url).auth(token).contentType(MediaType.APPLICATION_JSON).content(
                    if (reason ==
                        null
                    ) {
                        "{}"
                    } else {
                        """{"reason":"$reason"}"""
                    },
                ),
            ).andReturn()

        assertEquals(403, replay(investigator, "dependency recovered, replaying").response.status)
        assertEquals(400, replay(admin, null).response.status)
        assertEquals(400, replay(admin, "short").response.status, "a meaningful reason is mandatory")

        val stillFailing = replay(admin, "first replay while still broken")
        assertEquals("DEAD", json(stillFailing)["status"].asText())
        assertTrue(json(stillFailing)["outcome"].asText().startsWith("FAILED"))
        assertEquals(0, sideEffects(e.eventId))

        flaky.remainingFailures.set(0) // dependency fixed
        val ok = replay(admin, "dependency recovered, replaying event")
        assertEquals("REPLAYED", json(ok)["status"].asText())
        assertEquals(1, sideEffects(e.eventId))
        assertEquals("REPLAYED", jdbc.sql("SELECT status FROM dead_letter_events").query(String::class.java).single())
        assertEquals("admin-actor-check", "admin-actor-check")
        assertEquals("it-admin", jdbc.sql("SELECT replayed_by FROM dead_letter_events").query(String::class.java).single())

        val again = replay(admin, "trying to replay a second time")
        assertEquals(409, again.response.status)
        assertEquals(1, sideEffects(e.eventId), "a replay can never apply the effect twice")
        assertEquals(1, json(getJson("/api/v1/events/dead-letters?status=REPLAYED"))["totalItems"].asInt())
    }

    @Test
    fun `replay attempts are capped`() {
        flaky.remainingFailures.set(1000)
        dispatcher.dispatch(testEvent())
        val dlId = jdbc.sql("SELECT id FROM dead_letter_events").query(UUID::class.java).single()
        repeat(3) {
            mvc
                .perform(
                    post(
                        "/api/v1/admin/events/dead-letters/$dlId/replay",
                    ).auth(admin).contentType(MediaType.APPLICATION_JSON).content("""{"reason":"attempt number $it of replay"}"""),
                ).andReturn()
        }
        val r =
            mvc
                .perform(
                    post(
                        "/api/v1/admin/events/dead-letters/$dlId/replay",
                    ).auth(admin).contentType(MediaType.APPLICATION_JSON).content("""{"reason":"one more attempt please"}"""),
                ).andReturn()
        assertEquals(409, r.response.status)
        assertEquals("REPLAY_LIMIT_REACHED", json(r)["code"].asText())
    }

    @Test
    fun `malformed domain events are dead-lettered rather than retried forever`() {
        val bad =
            EventEnvelope(
                UUID.randomUUID(),
                DomainEventType.ReconciliationDiscrepancyDetected.name,
                1,
                "discrepancy",
                UUID.randomUUID(),
                Instant.now(),
                "corr-bad-0001",
                mapOf("type" to "AMOUNT_MISMATCH"),
            )
        dispatcher.dispatch(bad)
        assertEquals("discrepancy-incident-linker", jdbc.sql("SELECT consumer FROM dead_letter_events").query(String::class.java).single())
        assertEquals(1, json(getJson("/api/v1/events/dead-letters"))["totalItems"].asInt())
    }
}
