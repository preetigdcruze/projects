package com.paysense.integration

import org.junit.jupiter.api.Test
import org.springframework.http.MediaType
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class AiGatewayIT : IntegrationTestBase() {
    private fun investigate(
        id: UUID,
        token: String = investigator,
        question: String = "Why did this payment fail?",
    ) = mvc
        .perform(
            post(
                "/api/v1/ai/investigations",
            ).auth(
                token,
            ).contentType(MediaType.APPLICATION_JSON)
                .content("""{"subjectType":"PAYMENT","subjectId":"$id","question":"$question"}"""),
        ).andReturn()

    @Test
    fun `a successful investigation is persisted with provider metadata and the caller's identity is forwarded`() {
        StubAi.up()
        val id = newPaymentId()
        val r = investigate(id)
        assertEquals(201, r.response.status)
        val body = json(r)
        assertEquals("COMPLETED", body["status"].asText())
        assertEquals("mock", body["provider"].asText())
        assertEquals("mock-1", body["model"].asText())
        assertEquals(120, body["promptTokens"].asInt())
        assertEquals(40, body["completionTokens"].asInt())
        assertEquals("stub answer", body["result"]["summary"].asText())
        val seen = StubAi.requests.single { it["path"] == "/v1/investigations" }
        assertEquals(investigator, seen["authorization"], "the AI tools must act with the caller's own privileges")
        assertTrue(seen["internal"]!!.isNotBlank())
        assertTrue(seen["correlation"]!!.isNotBlank())
        assertTrue(seen["body"]!!.contains(id.toString()))
        assertEquals("COMPLETED", json(getJson("/api/v1/ai/investigations/${body["id"].asText()}"))["status"].asText())
        assertEquals(1, json(getJson("/api/v1/ai/investigations?subjectType=PAYMENT&subjectId=$id"))["totalItems"].asInt())
    }

    @Test
    fun `a degraded answer (LLM down, evidence only) is stored and labelled as such`() {
        StubAi.up()
        StubAi.body =
            """{"status":"DEGRADED","provider":"anthropic","errorCategory":"PROVIDER_TIMEOUT","facts":[{"id":"evt:1","text":"observed"}]}"""
        val r = json(investigate(newPaymentId()))
        assertEquals("DEGRADED", r["status"].asText())
        assertEquals("PROVIDER_TIMEOUT", r["errorCategory"].asText())
        assertEquals("observed", r["result"]["facts"][0]["text"].asText())
    }

    @Test
    fun `upstream failures and timeouts are mapped to UNAVAILABLE with a category`() {
        StubAi.up()
        StubAi.status = 500
        StubAi.body = """{"detail":"boom"}"""
        val upstream = json(investigate(newPaymentId()))
        assertEquals("UNAVAILABLE", upstream["status"].asText())
        assertEquals("UPSTREAM_ERROR", upstream["errorCategory"].asText())
        assertTrue(!upstream.has("result") || upstream["result"].isNull)

        StubAi.status = 200
        StubAi.delayMs = 2500 // read timeout is 1s in the test profile
        val slow = json(investigate(newPaymentId()))
        assertEquals("UNAVAILABLE", slow["status"].asText())
        assertEquals("TIMEOUT", slow["errorCategory"].asText())

        StubAi.status = 200
        StubAi.delayMs = 0
        StubAi.body = "this is not json"
        assertEquals("INVALID_RESPONSE", json(investigate(newPaymentId()))["errorCategory"].asText())
    }

    @Test
    fun `an unexpected status from the AI service never becomes a completed investigation`() {
        StubAi.up()
        StubAi.body = """{"status":"OK-BUT-WEIRD"}"""
        assertEquals("FAILED", json(investigate(newPaymentId()))["status"].asText())
    }

    @Test
    fun `analytics questions pass through and provider status is exposed`() {
        StubAi.up()
        StubAi.body = """{"status":"COMPLETED","operation":"processor_failure_rates"}"""
        val q =
            mvc
                .perform(
                    post(
                        "/api/v1/ai/analytics-queries",
                    ).auth(
                        viewer,
                    ).contentType(MediaType.APPLICATION_JSON)
                        .content("""{"question":"Which processor has the highest failure rate today?"}"""),
                ).andReturn()
        assertEquals("processor_failure_rates", json(q)["operation"].asText())
        assertEquals(viewer, StubAi.requests.last { it["path"] == "/v1/analytics-queries" }["authorization"])
        assertEquals(
            "ok",
            json(mvc.perform(get("/api/v1/ai/provider-status").auth(viewer)).andReturn())["status"].asText().lowercase().let {
                if (it ==
                    "completed"
                ) {
                    "ok"
                } else {
                    it
                }
            },
        )
        assertEquals(
            400,
            mvc
                .perform(
                    post(
                        "/api/v1/ai/analytics-queries",
                    ).auth(viewer).contentType(MediaType.APPLICATION_JSON).content("""{"question":"x"}"""),
                ).andReturn()
                .response.status,
        )
    }

    @Test
    fun `incident summaries are stored on the incident`() {
        StubAi.up()
        StubAi.body = """{"status":"COMPLETED","title":"Stub incident report","timeline":[]}"""
        val inc =
            json(
                mvc
                    .perform(
                        post(
                            "/api/v1/incidents",
                        ).auth(
                            investigator,
                        ).contentType(
                            MediaType.APPLICATION_JSON,
                        ).content("""{"title":"Manual incident","severity":"HIGH","components":["MOCK_PROCESSOR"]}"""),
                    ).andReturn(),
            )["id"].asText()
        val s = mvc.perform(post("/api/v1/incidents/$inc/summarize").auth(investigator)).andReturn()
        assertEquals("Stub incident report", json(s)["title"].asText())
        val detail = json(getJson("/api/v1/incidents/$inc"))
        assertEquals("Stub incident report", detail["incident"]["aiReport"]["title"].asText())
        assertNotNull(detail["incident"]["aiReportAt"])
        assertEquals(
            403,
            mvc
                .perform(post("/api/v1/incidents/$inc/summarize").auth(viewer))
                .andReturn()
                .response.status,
        )
    }

    @Test
    fun `the AI rate limit protects the endpoint`() {
        StubAi.up()
        val id = newPaymentId()
        val statuses = (1..25).map { investigate(id).response.status }
        assertTrue(statuses.take(20).all { it == 201 }, statuses.toString())
        assertTrue(statuses.drop(20).all { it == 429 }, "requests beyond 20/minute must be rejected: $statuses")
    }
}
