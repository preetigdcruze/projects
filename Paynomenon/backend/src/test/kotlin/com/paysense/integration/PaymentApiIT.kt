package com.paysense.integration

import org.junit.jupiter.api.Test
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PaymentApiIT : IntegrationTestBase() {
    @Test
    fun `creates and persists a payment with exact decimal amount`() {
        val r = createPayment(paymentBody("49.9"))
        assertEquals(201, r.response.status)
        val body = json(r)
        assertEquals("CREATED", body["status"].asText())
        assertTrue(
            r.response.contentAsString.contains("\"amount\":49.90"),
            "amount keeps its currency scale on the wire: ${r.response.contentAsString}",
        )
        assertEquals("EUR", body["currency"].asText())
        val id = UUID.fromString(body["id"].asText())
        assertEquals(
            "49.9000",
            jdbc
                .sql("SELECT amount::text FROM payments WHERE id = :id")
                .param("id", id)
                .query(String::class.java)
                .single(),
        )
        assertEquals(1, count("SELECT COUNT(*) FROM payment_events WHERE payment_id = '$id' AND event_type = 'PAYMENT_CREATED'"))
        assertEquals(1, count("SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = '$id' AND event_type = 'PaymentCreated'"))
        assertTrue(r.response.getHeader("X-Correlation-Id")!!.isNotBlank())
        assertEquals(body["correlationId"].asText(), r.response.getHeader("X-Correlation-Id"))
    }

    @Test
    fun `rejects invalid input with structured field errors`() {
        fun errors(body: String): Pair<Int, Set<String>> {
            val r = createPayment(body)
            return r.response.status to json(r)["details"].map { it["field"].asText() }.toSet()
        }
        assertEquals(400 to setOf("amount"), errors(paymentBody("0")))
        assertEquals(400 to setOf("amount"), errors(paymentBody("-5")))
        assertEquals(400 to setOf("amount"), errors(paymentBody("10.001")))
        assertEquals(400 to setOf("currency"), errors(paymentBody(currency = "XYZ")))
        assertEquals(400 to setOf("processor"), errors(paymentBody(processor = "NOPE")))
        assertEquals(400 to setOf("amount", "merchantId", "currency", "processor"), errors("{}"))
        assertEquals(400 to setOf("amount"), errors(paymentBody("1000000.01")))
        val malformed = createPayment("{not json")
        assertEquals(400, malformed.response.status)
        assertEquals("MALFORMED_REQUEST", json(malformed)["code"].asText())
        assertEquals(0, count("SELECT COUNT(*) FROM payments"))
    }

    @Test
    fun `error responses never leak stack traces or internals`() {
        val r = createPayment("{not json")
        val text = r.response.contentAsString
        assertFalse(text.contains("Exception") || text.contains("\tat ") || text.contains("com.paysense"), text)
        assertEquals(
            setOf("code", "message", "status", "timestamp", "path", "correlationId", "details"),
            json(r).fieldNames().asSequence().toSet(),
        )
    }

    @Test
    fun `oversized request bodies are rejected before parsing`() {
        val big = paymentBody(description = "x".repeat(70_000))
        val r = createPayment(big)
        assertEquals(413, r.response.status)
        assertEquals("PAYLOAD_TOO_LARGE", json(r)["code"].asText())
    }

    @Test
    fun `full lifecycle - authorize, capture, refund - with ledger, audit trail and outbox events`() {
        val id = newPaymentId()
        val authorize = operate(id, "authorize")
        assertEquals(200, authorize.response.status)
        assertEquals("AUTHORIZED", json(authorize)["status"].asText())
        assertEquals("APPROVED", json(authorize)["attempts"][0]["status"].asText())
        assertEquals(0, count("SELECT COUNT(*) FROM ledger_transactions"), "authorization is a hold, not a movement of money")

        assertEquals("CAPTURED", json(operate(id, "capture"))["status"].asText())
        assertEquals(1, count("SELECT COUNT(*) FROM ledger_transactions WHERE operation = 'CAPTURE'"))

        val refund = operate(id, "refund", admin)
        assertEquals("REFUNDED", json(refund)["status"].asText())
        assertEquals(
            0,
            java.math.BigDecimal("49.99").compareTo(json(refund)["amount"].decimalValue()),
            "refund must not mutate the original amount",
        )
        assertEquals(
            2,
            count(
                "SELECT COUNT(*) FROM ledger_entries WHERE transaction_id IN (SELECT id FROM ledger_transactions WHERE operation = 'REFUND')",
            ),
        )
        assertEquals(
            0L,
            count(
                "SELECT COUNT(*) FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END) <> 0) x",
            ),
            "every ledger transaction must balance",
        )
        val events = json(getJson("/api/v1/payments/$id/events"))["items"].map { it["eventType"].asText() + ":" + it["toStatus"].asText() }
        assertEquals(
            listOf(
                "PAYMENT_CREATED:CREATED",
                "OPERATION_STARTED:PROCESSING",
                "OPERATION_SUCCEEDED:AUTHORIZED",
                "OPERATION_STARTED:CAPTURING",
                "OPERATION_SUCCEEDED:CAPTURED",
                "OPERATION_STARTED:REFUNDING",
                "OPERATION_SUCCEEDED:REFUNDED",
            ),
            events,
        )
        assertEquals(
            listOf("PaymentCreated", "PaymentAuthorized", "PaymentCaptured", "PaymentRefunded"),
            jdbc
                .sql("SELECT event_type FROM outbox_events ORDER BY created_at, id")
                .query(String::class.java)
                .list()
                .let { l ->
                    l
                }.sortedBy { listOf("PaymentCreated", "PaymentAuthorized", "PaymentCaptured", "PaymentRefunded").indexOf(it) },
        )
    }

    @Test
    fun `invalid state transitions are rejected with 409 and change nothing`() {
        val id = newPaymentId()
        assertEquals(409, operate(id, "capture").response.status)
        assertEquals("INVALID_STATE_TRANSITION", json(operate(id, "capture"))["code"].asText())
        assertEquals(409, operate(id, "refund", admin).response.status)
        operate(id, "authorize")
        assertEquals(409, operate(id, "authorize").response.status, "authorizing twice")
        assertEquals("AUTHORIZED", status(id))
        assertEquals(404, operate(UUID.randomUUID(), "authorize").response.status)
    }

    @Test
    fun `only full refunds are supported`() {
        val id = newPaymentId()
        operate(id, "authorize")
        operate(id, "capture")
        val partial = operate(id, "refund", admin, body = """{"amount":10.00}""")
        assertEquals(422, partial.response.status)
        assertEquals("PARTIAL_REFUND_NOT_SUPPORTED", json(partial)["code"].asText())
        assertEquals("CAPTURED", status(id))
        assertEquals(200, operate(id, "refund", admin, body = """{"amount":49.99}""").response.status)
    }

    @Test
    fun `a declined authorization ends in FAILED with the processor's reason and no ledger movement`() {
        val id = newPaymentId(paymentBody(description = "[sim:insufficient_funds]"))
        val r = operate(id, "authorize")
        assertEquals(200, r.response.status)
        assertEquals("FAILED", json(r)["status"].asText())
        assertEquals("INSUFFICIENT_FUNDS", json(r)["failureCode"].asText())
        assertEquals("DECLINED", json(r)["attempts"][0]["status"].asText())
        assertEquals(1, count("SELECT COUNT(*) FROM outbox_events WHERE event_type = 'PaymentFailed'"))
        assertEquals(409, operate(id, "authorize").response.status, "FAILED is terminal")
    }

    @Test
    fun `cancel voids uncaptured payments only`() {
        val id = newPaymentId()
        assertEquals("CANCELLED", json(mvc.perform(post("/api/v1/payments/$id/cancel").auth(investigator)).andReturn())["status"].asText())
        val captured = newPaymentId()
        operate(captured, "authorize")
        operate(captured, "capture")
        assertEquals(
            409,
            mvc
                .perform(post("/api/v1/payments/$captured/cancel").auth(investigator))
                .andReturn()
                .response.status,
        )
    }

    @Test
    fun `listing supports filters, pagination and a whitelist for sorting`() {
        repeat(5) { newPaymentId(paymentBody("${10 + it}.00", description = "order-$it")) }
        val usd = newPaymentId(paymentBody("20.00", "USD", "MOCK_PROCESSOR_EU"))
        operate(usd, "authorize")
        val all = json(getJson("/api/v1/payments?size=4&page=1"))
        assertEquals(6, all["totalItems"].asInt())
        assertEquals(2, all["totalPages"].asInt())
        assertEquals(2, all["items"].size())
        assertEquals(1, json(getJson("/api/v1/payments?status=AUTHORIZED"))["totalItems"].asInt())
        assertEquals(1, json(getJson("/api/v1/payments?currency=usd&processor=MOCK_PROCESSOR_EU"))["totalItems"].asInt())
        assertEquals(1, json(getJson("/api/v1/payments?q=order-3"))["totalItems"].asInt())
        assertEquals(1, json(getJson("/api/v1/payments?q=$usd"))["totalItems"].asInt())
        val sorted = json(getJson("/api/v1/payments?sort=amount,asc&size=2"))["items"].map { it["amount"].decimalValue().toInt() }
        assertEquals(listOf(10, 11), sorted)
        assertEquals(400, getJson("/api/v1/payments?sort=password,asc").response.status)
        assertEquals(400, getJson("/api/v1/payments?size=1000").response.status)
        assertEquals(400, getJson("/api/v1/payments?status=BOGUS").response.status)
        assertEquals(400, getJson("/api/v1/payments?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z").response.status)
    }

    @Test
    fun `payment detail includes processor attempts and 404s for unknown ids`() {
        val id = newPaymentId()
        operate(id, "authorize")
        val detail = json(getJson("/api/v1/payments/$id"))
        assertEquals(1, detail["attempts"].size())
        assertEquals("MOCK_PROCESSOR", detail["attempts"][0]["processor"].asText())
        assertEquals("$id:AUTHORIZE:1", detail["attempts"][0]["processorRequestId"].asText())
        assertEquals(404, getJson("/api/v1/payments/${UUID.randomUUID()}").response.status)
        assertEquals(400, getJson("/api/v1/payments/not-a-uuid").response.status)
    }

    @Test
    fun `the audit trail is append-only at the database level`() {
        val id = newPaymentId()
        val ex1 = runCatching { jdbc.sql("UPDATE payment_events SET actor = 'attacker' WHERE payment_id = :id").param("id", id).update() }
        val ex2 = runCatching { jdbc.sql("DELETE FROM payment_events WHERE payment_id = :id").param("id", id).update() }
        assertTrue(ex1.isFailure && ex2.isFailure)
        assertTrue(ex1.exceptionOrNull()!!.message!!.contains("append-only"))
    }

    @Test
    fun `unauthenticated and under-privileged callers are rejected consistently`() {
        val noAuth = mvc.perform(get("/api/v1/payments")).andReturn()
        assertEquals(401, noAuth.response.status)
        assertEquals("UNAUTHENTICATED", json(noAuth)["code"].asText())
        assertEquals(
            401,
            mvc
                .perform(get("/api/v1/payments").header("Authorization", "Bearer garbage.token.value"))
                .andReturn()
                .response.status,
        )
        assertEquals(403, createPayment(token = viewer).response.status)
        val id = newPaymentId()
        operate(id, "authorize")
        operate(id, "capture")
        assertEquals(403, operate(id, "refund", investigator).response.status, "refunds are ADMIN only")
        assertEquals(403, operate(id, "authorize", viewer).response.status)
        assertEquals(200, getJson("/api/v1/payments", viewer).response.status)
        assertEquals(
            403,
            mvc
                .perform(
                    post("/api/v1/admin/seed").auth(investigator).contentType(MediaType.APPLICATION_JSON).content("{}"),
                ).andReturn()
                .response.status,
        )
        assertEquals(
            403,
            mvc
                .perform(get("/api/v1/dev/simulation").auth(investigator))
                .andReturn()
                .response.status,
        )
        assertEquals(
            200,
            mvc
                .perform(get("/api/v1/dev/simulation").auth(admin))
                .andReturn()
                .response.status,
        )
        assertEquals("CAPTURED", status(id))
    }

    @Test
    fun `login issues a token that works, and bad credentials are rejected without detail`() {
        val bad =
            mvc
                .perform(
                    post(
                        "/api/v1/auth/login",
                    ).contentType(MediaType.APPLICATION_JSON).content("""{"username":"admin","password":"wrong-password"}"""),
                ).andReturn()
        assertEquals(401, bad.response.status)
        assertEquals("INVALID_CREDENTIALS", json(bad)["code"].asText())
        val unknown =
            mvc
                .perform(
                    post(
                        "/api/v1/auth/login",
                    ).contentType(MediaType.APPLICATION_JSON).content("""{"username":"nobody","password":"wrong-password"}"""),
                ).andReturn()
        assertEquals(json(bad)["message"].asText(), json(unknown)["message"].asText(), "no user enumeration")
        val ok =
            json(
                mvc
                    .perform(
                        post(
                            "/api/v1/auth/login",
                        ).contentType(MediaType.APPLICATION_JSON).content("""{"username":"viewer","password":"viewer-demo-pass"}"""),
                    ).andReturn(),
            )
        assertEquals("VIEWER", ok["role"].asText())
        assertEquals(
            200,
            mvc
                .perform(get("/api/v1/payments").header("Authorization", "Bearer " + ok["accessToken"].asText()))
                .andReturn()
                .response.status,
        )
    }

    @Test
    fun `actuator health is public but prometheus needs credentials`() {
        assertEquals(
            200,
            mvc
                .perform(get("/actuator/health"))
                .andReturn()
                .response.status,
        )
        assertEquals(
            401,
            mvc
                .perform(get("/actuator/prometheus"))
                .andReturn()
                .response.status,
        )
        assertTrue(
            mvc
                .perform(get("/actuator/prometheus").auth(admin))
                .andReturn()
                .response.status >= 400,
            "bearer tokens are not accepted on the ops endpoints",
        )
        val ok =
            mvc
                .perform(
                    get("/actuator/prometheus").header(
                        "Authorization",
                        "Basic " +
                            java.util.Base64
                                .getEncoder()
                                .encodeToString("prometheus:dev-metrics-password".toByteArray()),
                    ),
                ).andReturn()
        assertEquals(200, ok.response.status)
        assertTrue(ok.response.contentAsString.contains("paysense_payment_outcomes") || ok.response.contentAsString.contains("jvm_memory"))
    }
}
