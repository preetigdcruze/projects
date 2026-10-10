package com.paysense.integration

import com.fasterxml.jackson.databind.ObjectMapper
import com.paysense.events.EventEnvelope
import com.paysense.events.KafkaEventTransport
import com.paysense.events.KafkaLagReader
import com.paysense.events.OutboxPublisher
import com.paysense.processors.SimOutcome
import com.paysense.processors.SimulationControl
import com.paysense.security.Role
import com.paysense.security.TokenService
import com.paysense.security.UserAccount
import org.apache.kafka.clients.producer.ProducerRecord
import org.awaitility.Awaitility.await
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.http.MediaType
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.kafka.config.KafkaListenerEndpointRegistry
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.kafka.test.context.EmbeddedKafka
import org.springframework.test.context.ActiveProfiles
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import java.time.Duration
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Runs the real pipeline - outbox -> Kafka broker -> consumer group -> handlers - against an embedded KRaft broker. */
@Tag("integration")
@SpringBootTest(
    properties = [
        "paysense.events.transport=kafka",
        "spring.kafka.bootstrap-servers=\${spring.embedded.kafka.brokers}",
        "spring.kafka.consumer.auto-offset-reset=earliest",
    ],
)
@AutoConfigureMockMvc
@ActiveProfiles("test")
@EmbeddedKafka(partitions = 3, topics = ["paysense.events.v1"], kraft = true)
class KafkaIT {
    @Autowired lateinit var mvc: MockMvc

    @Autowired lateinit var mapper: ObjectMapper

    @Autowired lateinit var jdbc: JdbcClient

    @Autowired lateinit var publisher: OutboxPublisher

    @Autowired lateinit var simulation: SimulationControl

    @Autowired lateinit var kafka: KafkaTemplate<String, String>

    @Autowired lateinit var registry: KafkaListenerEndpointRegistry

    @Autowired lateinit var lag: KafkaLagReader

    @Autowired lateinit var tokens: TokenService

    companion object {
        @JvmStatic
        @DynamicPropertySource
        fun database(r: DynamicPropertyRegistry) {
            val s = TestDatabase.settings
            r.add("spring.datasource.url") { s.url }
            r.add("spring.datasource.username") { s.user }
            r.add("spring.datasource.password") { s.password }
        }
    }

    private val token by lazy { "Bearer " + tokens.issue(UserAccount(username = "kafka-it", role = Role.ADMIN)).token }

    @BeforeEach
    fun reset() {
        jdbc
            .sql(
                "TRUNCATE payments, payment_attempts, payment_events, idempotency_records, ledger_transactions, ledger_entries, outbox_events, processed_events, dead_letter_events, mock_processor_transactions, processor_callbacks, incidents, incident_links, operational_logs RESTART IDENTITY CASCADE",
            ).update()
        simulation.reset()
        registry.listenerContainers.forEach { if (!it.isRunning) it.start() }
    }

    private fun count(sql: String) = jdbc.sql(sql).query(Long::class.java).single()

    private fun newPayment(): UUID {
        val r =
            mvc
                .perform(
                    post(
                        "/api/v1/payments",
                    ).header(
                        "Authorization",
                        token,
                    ).contentType(
                        MediaType.APPLICATION_JSON,
                    ).content("""{"amount":10.00,"currency":"EUR","merchantId":"m","processor":"MOCK_PROCESSOR"}"""),
                ).andReturn()
        return UUID.fromString(mapper.readTree(r.response.contentAsString)["id"].asText())
    }

    private fun operate(
        id: UUID,
        op: String,
    ) = mvc
        .perform(
            post("/api/v1/payments/$id/$op").header("Authorization", token).contentType(MediaType.APPLICATION_JSON).content("{}"),
        ).andReturn()

    private fun status(id: UUID) =
        jdbc
            .sql("SELECT status FROM payments WHERE id = :id")
            .param("id", id)
            .query(String::class.java)
            .single()

    private fun discrepancyEvent(eventId: UUID = UUID.randomUUID()) =
        EventEnvelope(
            eventId,
            "ReconciliationDiscrepancyDetected",
            1,
            "discrepancy",
            UUID.randomUUID(),
            Instant.now(),
            "corr-kafka-0001",
            mapOf("discrepancyId" to UUID.randomUUID().toString(), "processor" to "MOCK_PROCESSOR", "type" to "AMOUNT_MISMATCH"),
        )

    private fun publishRaw(e: EventEnvelope) {
        kafka.send(ProducerRecord("paysense.events.v1", e.aggregateId.toString(), mapper.writeValueAsString(e))).get(10, TimeUnit.SECONDS)
    }

    @Test
    fun `payment events travel through the real broker and an ambiguous timeout is resolved by the consumer`() {
        val id = newPayment()
        simulation.forceNext("MOCK_PROCESSOR", SimOutcome.TIMEOUT_EXECUTED, 1)
        assertEquals("UNCERTAIN", mapper.readTree(operate(id, "authorize").response.contentAsString)["status"].asText())
        assertTrue(publisher.publishBatch() >= 2)
        await().atMost(Duration.ofSeconds(30)).untilAsserted { assertEquals("AUTHORIZED", status(id)) }
        assertEquals(
            1,
            count("SELECT COUNT(*) FROM outbox_events WHERE status = 'PENDING' AND event_type = 'PaymentAuthorized'"),
            "the resolution itself emitted a new event through the outbox",
        )
        publisher.publishBatch()
        assertEquals(0, count("SELECT COUNT(*) FROM outbox_events WHERE status <> 'PUBLISHED'"))
        assertEquals(1, count("SELECT COUNT(*) FROM mock_processor_transactions"), "resolution used a lookup, not a second charge")
    }

    @Test
    fun `at-least-once delivery - the same event arriving twice has its effect once`() {
        val e = discrepancyEvent()
        publishRaw(e)
        publishRaw(e)
        await().atMost(Duration.ofSeconds(30)).untilAsserted {
            assertEquals(1, count("SELECT COUNT(*) FROM processed_events WHERE event_id = '${e.eventId}'"))
        }
        Thread.sleep(500) // give the duplicate time to be consumed
        assertEquals(1, count("SELECT COUNT(*) FROM incident_links WHERE link_type = 'DISCREPANCY'"))
        assertEquals(1, count("SELECT COUNT(*) FROM incidents"))
    }

    @Test
    fun `unparseable messages are dead-lettered and do not block the partition`() {
        kafka.send(ProducerRecord("paysense.events.v1", "poison-key", "{ this is not an event")).get(10, TimeUnit.SECONDS)
        val ok = discrepancyEvent()
        publishRaw(ok)
        await().atMost(Duration.ofSeconds(30)).untilAsserted {
            assertEquals(1, count("SELECT COUNT(*) FROM dead_letter_events WHERE consumer = 'deserializer'"))
            assertEquals(1, count("SELECT COUNT(*) FROM processed_events WHERE event_id = '${ok.eventId}'"))
        }
        assertTrue(
            jdbc
                .sql("SELECT payload FROM dead_letter_events")
                .query(String::class.java)
                .single()
                .contains("not an event"),
        )
    }

    @Test
    fun `a stopped consumer builds measurable lag, and catches up exactly once after restart`() {
        val warmup = discrepancyEvent()
        publishRaw(warmup)
        await().atMost(Duration.ofSeconds(30)).untilAsserted { assertEquals(1, count("SELECT COUNT(*) FROM processed_events")) }
        await().atMost(Duration.ofSeconds(10)).until { lag.read() != null }

        registry.listenerContainers.forEach { it.stop() } // "worker down"
        val missed = (1..5).map { discrepancyEvent() }
        missed.forEach(::publishRaw)
        await().atMost(Duration.ofSeconds(20)).untilAsserted { assertEquals(5L, lag.read()?.totalLag) }
        assertEquals(1, count("SELECT COUNT(*) FROM processed_events"))

        registry.listenerContainers.forEach { it.start() } // "worker restarted"
        await().atMost(Duration.ofSeconds(30)).untilAsserted { assertEquals(6, count("SELECT COUNT(*) FROM processed_events")) }
        await().atMost(Duration.ofSeconds(20)).untilAsserted { assertEquals(0L, lag.read()?.totalLag) }
        assertEquals(6, count("SELECT COUNT(*) FROM incident_links WHERE link_type = 'DISCREPANCY'"), "no event lost, none applied twice")
        // redelivery after restart (e.g. offsets not yet committed when the worker died) is harmless
        publishRaw(missed[0])
        Thread.sleep(800)
        assertEquals(6, count("SELECT COUNT(*) FROM incident_links WHERE link_type = 'DISCREPANCY'"))
    }

    @Test
    fun `an unreachable broker makes publication fail fast, so the outbox keeps the event`() {
        val badTemplate =
            KafkaTemplate(
                org.springframework.kafka.core.DefaultKafkaProducerFactory<String, String>(
                    mapOf(
                        "bootstrap.servers" to "127.0.0.1:1",
                        "key.serializer" to "org.apache.kafka.common.serialization.StringSerializer",
                        "value.serializer" to "org.apache.kafka.common.serialization.StringSerializer",
                        "max.block.ms" to 500,
                        "delivery.timeout.ms" to 1000,
                        "request.timeout.ms" to 500,
                    ),
                ),
            )
        val props = com.paysense.PropsFactory.props()
        val transport = KafkaEventTransport(badTemplate, mapper, props)
        assertFailsWith<Exception> { transport.send(discrepancyEvent()) }
    }

    @Test
    fun `consumer lag and kafka transport are visible on the system status endpoint`() {
        publishRaw(discrepancyEvent())
        await().atMost(Duration.ofSeconds(30)).untilAsserted { assertEquals(1, count("SELECT COUNT(*) FROM processed_events")) }
        await().atMost(Duration.ofSeconds(15)).untilAsserted {
            val r =
                mvc
                    .perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                            .get(
                                "/api/v1/system/status",
                            ).header("Authorization", token),
                    ).andReturn()
            val body = mapper.readTree(r.response.contentAsString)
            assertEquals("kafka", body["events"]["transport"].asText())
            assertEquals(true, body["events"]["consumerLagAvailable"].asBoolean())
            assertNotNull(body["events"]["outbox"])
        }
    }
}
