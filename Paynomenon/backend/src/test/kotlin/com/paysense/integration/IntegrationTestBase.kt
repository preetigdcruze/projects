package com.paysense.integration

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.paysense.events.EventEnvelope
import com.paysense.events.EventTransport
import com.paysense.events.InProcessEventTransport
import com.paysense.processors.ResilientProcessorClient
import com.paysense.processors.SimulationControl
import com.paysense.security.Role
import com.paysense.security.TokenService
import com.paysense.security.UserAccount
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Tag
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Primary
import org.springframework.http.MediaType
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.test.context.ActiveProfiles
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.MvcResult
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.testcontainers.DockerClientFactory
import org.testcontainers.containers.PostgreSQLContainer
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Resolves the PostgreSQL used by integration tests:
 *   1. TEST_DATABASE_URL (+ TEST_DATABASE_USER / TEST_DATABASE_PASSWORD) when set - e.g. a local or CI service container;
 *   2. otherwise a Testcontainers PostgreSQL when a Docker daemon is available.
 * Tests never fall back to an in-memory database: the schema relies on PostgreSQL triggers, jsonb and row locks.
 */
object TestDatabase {
    class Settings(
        val url: String,
        val user: String,
        val password: String,
    )

    val settings: Settings by lazy {
        val url = System.getenv("TEST_DATABASE_URL")
        if (url != null) {
            Settings(url, System.getenv("TEST_DATABASE_USER") ?: "paysense", System.getenv("TEST_DATABASE_PASSWORD") ?: "paysense")
        } else if (runCatching { DockerClientFactory.instance().isDockerAvailable }.getOrDefault(false)) {
            val c =
                PostgreSQLContainer(
                    "postgres:16-alpine",
                ).withDatabaseName("paysense_test").withUsername("paysense").withPassword("paysense")
            c.start()
            Settings(c.jdbcUrl, c.username, c.password)
        } else {
            error("Integration tests need PostgreSQL: set TEST_DATABASE_URL or start Docker (Testcontainers). See docs/testing.md")
        }
    }
}

/**
 * A stand-in for the Python AI service so the backend's gateway behaviour (header forwarding, degradation,
 * timeouts, error mapping) is tested for real over HTTP. Stopped by default = "AI service is down".
 */
object StubAi {
    val port: Int = java.net.ServerSocket(0).use { it.localPort }
    private var server: com.sun.net.httpserver.HttpServer? = null
    val requests = java.util.concurrent.CopyOnWriteArrayList<Map<String, String>>()

    @Volatile var status = 200

    @Volatile var body = """{"status":"COMPLETED","provider":"mock","model":"mock-1","usage":{"promptTokens":120,"completionTokens":40},"summary":"stub answer"}"""

    @Volatile var delayMs = 0L

    @Synchronized
    fun up() {
        if (server != null) return
        val s =
            com.sun.net.httpserver.HttpServer
                .create(java.net.InetSocketAddress("127.0.0.1", port), 0)
        s.createContext("/") { ex ->
            requests +=
                mapOf(
                    "path" to ex.requestURI.path,
                    "method" to ex.requestMethod,
                    "authorization" to (ex.requestHeaders.getFirst("Authorization") ?: ""),
                    "internal" to (ex.requestHeaders.getFirst("X-Internal-Token") ?: ""),
                    "correlation" to (ex.requestHeaders.getFirst("X-Correlation-Id") ?: ""),
                    "body" to String(ex.requestBody.readAllBytes()),
                )
            if (delayMs > 0) Thread.sleep(delayMs)
            val bytes = (if (ex.requestURI.path == "/health") """{"status":"ok","provider":"mock"}""" else body).toByteArray()
            ex.responseHeaders.add("Content-Type", "application/json")
            ex.sendResponseHeaders(if (ex.requestURI.path == "/health") 200 else status, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        s.executor =
            java.util.concurrent.Executors
                .newCachedThreadPool()
        s.start()
        server = s
    }

    @Synchronized
    fun down() {
        server?.stop(0)
        server = null
    }

    fun reset() {
        down()
        requests.clear()
        status = 200
        delayMs = 0
        body =
            """{"status":"COMPLETED","provider":"mock","model":"mock-1","usage":{"promptTokens":120,"completionTokens":40},"summary":"stub answer"}"""
    }
}

/** Event transport whose failures can be switched on, to test publisher retry and recovery. */
class ControllableTransport(
    private val delegate: InProcessEventTransport,
) : EventTransport {
    val failing = AtomicBoolean(false)
    val sent = CopyOnWriteArrayList<EventEnvelope>()
    val deliverTwice = AtomicBoolean(false)

    override fun send(event: EventEnvelope) {
        if (failing.get()) throw IllegalStateException("broker unavailable (test)")
        sent += event
        delegate.send(event)
        if (deliverTwice.get()) delegate.send(event) // at-least-once: the same event may arrive again
    }
}

/**
 * A test-only consumer that can be told to fail, to exercise retry, dead-lettering, replay and crash recovery.
 * "crashAfterSideEffect" writes a row and then throws, like a worker dying before its transaction commits.
 */
class FlakyHandler(
    private val jdbc: JdbcClient,
) : com.paysense.events.EventHandler {
    override val name = "flaky-test-handler"
    val remainingFailures =
        java.util.concurrent.atomic
            .AtomicInteger(0)
    val invocations =
        java.util.concurrent.atomic
            .AtomicInteger(0)
    val crashAfterSideEffect = AtomicBoolean(false)
    val permanent = AtomicBoolean(false)

    override fun supports(eventType: String) = eventType == "TestEvent"

    override fun handle(event: EventEnvelope) {
        invocations.incrementAndGet()
        if (permanent.get()) throw IllegalArgumentException("malformed payload (test)")
        jdbc
            .sql(
                "INSERT INTO operational_logs (occurred_at, level, component, message) VALUES (now(), 'INFO', 'flaky-test', :m)",
            ).param("m", "effect:${event.eventId}")
            .update()
        if (remainingFailures.getAndUpdate { if (it > 0) it - 1 else 0 } > 0) {
            throw IllegalStateException(
                if (crashAfterSideEffect.get()) "worker died after side effect (test)" else "transient failure (test)",
            )
        }
    }

    fun reset() {
        remainingFailures.set(0)
        invocations.set(0)
        crashAfterSideEffect.set(false)
        permanent.set(false)
    }
}

@TestConfiguration
class TestInfra {
    @Bean
    fun flakyHandler(jdbc: JdbcClient) = FlakyHandler(jdbc)

    @Bean
    @Primary
    fun controllableTransport(delegate: InProcessEventTransport) = ControllableTransport(delegate)
}

@Tag("integration")
@SpringBootTest
@AutoConfigureMockMvc
@org.springframework.boot.test.autoconfigure.actuate.observability.AutoConfigureObservability
@ActiveProfiles("test")
@org.springframework.context.annotation.Import(TestInfra::class)
abstract class IntegrationTestBase {
    @Autowired protected lateinit var mvc: MockMvc

    @Autowired protected lateinit var mapper: ObjectMapper

    @Autowired protected lateinit var jdbc: JdbcClient

    @Autowired protected lateinit var tokens: TokenService

    @Autowired protected lateinit var simulation: SimulationControl

    @Autowired protected lateinit var processorClient: ResilientProcessorClient

    @Autowired protected lateinit var transport: ControllableTransport

    @Autowired protected lateinit var flaky: FlakyHandler

    @Autowired protected lateinit var rateLimiter: com.paysense.security.RateLimiter

    companion object {
        @JvmStatic
        @DynamicPropertySource
        fun database(registry: DynamicPropertyRegistry) {
            val s = TestDatabase.settings
            registry.add("spring.datasource.url") { s.url }
            registry.add("spring.datasource.username") { s.user }
            registry.add("spring.datasource.password") { s.password }
            registry.add("paysense.ai.base-url") { "http://127.0.0.1:${StubAi.port}" }
        }
    }

    protected val admin by lazy { bearer("it-admin", Role.ADMIN) }
    protected val investigator by lazy { bearer("it-investigator", Role.INVESTIGATOR) }
    protected val viewer by lazy { bearer("it-viewer", Role.VIEWER) }

    private fun bearer(
        name: String,
        role: Role,
    ) = "Bearer " + tokens.issue(UserAccount(username = name, role = role)).token

    @BeforeEach
    fun resetState() {
        jdbc
            .sql(
                """
            TRUNCATE payments, payment_attempts, payment_events, idempotency_records, ledger_transactions, ledger_entries, outbox_events,
                     processed_events, dead_letter_events, mock_processor_transactions, processor_callbacks, reconciliation_runs,
                     processor_settlement_records, reconciliation_discrepancies, incidents, incident_links, anomaly_events,
                     ai_investigations, operational_logs RESTART IDENTITY CASCADE
            """,
            ).update()
        simulation.reset()
        processorClient.resetCircuits()
        transport.failing.set(false)
        transport.deliverTwice.set(false)
        transport.sent.clear()
        flaky.reset()
        StubAi.reset()
        (rateLimiter as? com.paysense.security.InMemoryRateLimiter)?.reset()
    }

    // ---- request helpers ----------------------------------------------------------------------------------

    protected fun json(r: MvcResult): JsonNode = mapper.readTree(r.response.contentAsString)

    protected fun MockHttpServletRequestBuilder.auth(token: String) = header("Authorization", token)

    protected fun paymentBody(
        amount: String = "49.99",
        currency: String = "EUR",
        processor: String = "MOCK_PROCESSOR",
        description: String? = "IT payment",
        merchant: String = "merchant-it",
    ) = """{"amount":$amount,"currency":"$currency","merchantId":"$merchant","processor":"$processor"${description?.let {
        ""","description":"$it""""
    } ?: ""}}"""

    protected fun createPayment(
        body: String = paymentBody(),
        key: String? = null,
        token: String = investigator,
    ): MvcResult =
        mvc
            .perform(
                post("/api/v1/payments").auth(token).contentType(MediaType.APPLICATION_JSON).content(body).also { b ->
                    key?.let { b.header("Idempotency-Key", it) }
                },
            ).andReturn()

    protected fun newPaymentId(body: String = paymentBody()): UUID = UUID.fromString(json(createPayment(body)).get("id").asText())

    protected fun operate(
        id: UUID,
        op: String,
        token: String = investigator,
        key: String? = null,
        body: String? = null,
    ): MvcResult =
        mvc
            .perform(
                post("/api/v1/payments/$id/$op").auth(token).contentType(MediaType.APPLICATION_JSON).content(body ?: "{}").also { b ->
                    key?.let { b.header("Idempotency-Key", it) }
                },
            ).andReturn()

    protected fun status(id: UUID): String =
        jdbc
            .sql("SELECT status FROM payments WHERE id = :id")
            .param("id", id)
            .query(String::class.java)
            .single()

    protected fun count(sql: String): Long = jdbc.sql(sql).query(Long::class.java).single()

    protected fun getJson(
        path: String,
        token: String = viewer,
    ): MvcResult = mvc.perform(get(path).auth(token)).andReturn()
}
